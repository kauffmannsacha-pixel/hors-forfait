// Analyse d'une niche/chaîne : vidéos les plus vues → miniatures (blob, sans canvas « tainted ») →
// mesures locales → Claude Vision par lots → bibliothèque en cache (kv). Annulable, progressive.
import { ensureLoaded, flushLibrary, setItemStatus, updateJob, upsertRecords, useThumbs, type AnalysisJob } from '../state';
import { analysisRaster, decodeBlob, fetchYtThumbnail, toVisionJpeg, ytThumbUrl, type Drawable, type VisionImage } from './browserImage';
import { computeMetrics } from './metrics';
import type { ThumbRecord } from './types';
import { analyzeCompetitors, thumbnailPrinciples } from './vision';
import { channelStats, nicheKey, topVideos, type Period } from './youtube';

export interface AnalysisOptions {
  mode: 'niche' | 'chaine'; query: string; label: string; max: number;
  excludeShorts: boolean; lang: '' | 'fr' | 'en'; period: Period;
  vision: boolean; fast: boolean; reanalyze: boolean;
}

let controller: AbortController | null = null;
export const cancelAnalysis = () => controller?.abort();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown, s?: AbortSignal) => !!s?.aborted || (e instanceof Error && (e.name === 'AbortError' || /annulée/.test(e.message)));
const yieldUi = () => new Promise<void>(r => setTimeout(r, 0));
const closeSrc = (src: Drawable) => { if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) src.close(); };

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** Télécharge, mesure et prépare l'image Vision d'un enregistrement (muté en place). */
async function processImage(rec: ThumbRecord, apiUrl: string | undefined, wantMetrics: boolean, wantVision: boolean, signal?: AbortSignal): Promise<VisionImage | undefined> {
  const { blob, url } = await fetchYtThumbnail(rec.videoId, apiUrl, signal);
  const src = await decodeBlob(blob);
  try {
    rec.imageUrl = url;
    const { img, crop } = analysisRaster(src);
    if (wantMetrics) { rec.metrics = computeMetrics(img); rec.metricsError = undefined; }
    rec.analyzedAt = Date.now();
    return wantVision ? await toVisionJpeg(src, { crop }) : undefined;
  } finally { closeSrc(src); }
}

export async function runAnalysis(o: AnalysisOptions): Promise<void> {
  if (useThumbs.getState().job?.status === 'en cours') throw new Error('Une analyse est déjà en cours.');
  await ensureLoaded();
  controller = new AbortController(); const signal = controller.signal;
  const job: AnalysisJob = { id: crypto.randomUUID(), label: o.query.trim(), niche: '', status: 'en cours', step: o.mode === 'chaine' ? 'Recherche de la chaîne et de ses vidéos les plus vues…' : 'Recherche des vidéos les plus vues de la niche…', items: [], warnings: [], startedAt: Date.now() };
  useThumbs.setState({ job });
  const warn = (w: string) => updateJob(j => ({ warnings: [...new Set([...j.warnings, w])] }));
  try {
    const { videos, label } = await topVideos({ mode: o.mode, query: o.query, max: o.max, excludeShorts: o.excludeShorts, lang: o.lang, period: o.period });
    if (signal.aborted) throw Object.assign(new Error('Analyse annulée.'), { name: 'AbortError' });
    if (!videos.length) throw new Error('Aucune vidéo trouvée : élargis la recherche ou la période.');
    const niche = nicheKey(o.label.trim() || label);
    updateJob({ niche, label, items: videos.map(v => ({ videoId: v.id, status: 'attente' as const })), step: 'Abonnés des chaînes (performance vues/abonnés)…' });

    let subs: Awaited<ReturnType<typeof channelStats>> = {};
    try { subs = await channelStats(videos.map(v => v.channelId)); } catch (e) { warn(`Abonnés indisponibles (performance limitée aux vues) : ${errMsg(e)}`); }

    const lib = useThumbs.getState().library;
    const recs = new Map<string, ThumbRecord>();
    for (const v of videos) {
      const prev = lib[v.id];
      const sub = subs[v.channelId]?.subscribers;
      recs.set(v.id, {
        ...prev, videoId: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channelTitle, publishedAt: v.publishedAt,
        durationSec: v.durationSec, views: v.views, likes: v.likes, subscribers: sub, ratio: sub ? v.views / sub : undefined,
        niche, niches: [...new Set([...(prev?.niches ?? (prev?.niche ? [prev.niche] : [])), niche])],
        source: { kind: o.mode, query: o.query.trim() }, imageUrl: prev?.imageUrl ?? ytThumbUrl(v.id), analyzedAt: prev?.analyzedAt ?? Date.now(),
      });
    }
    upsertRecords([...recs.values()]);

    const needM = new Set(videos.filter(v => o.reanalyze || !recs.get(v.id)!.metrics).map(v => v.id));
    const needV = new Set(o.vision ? videos.filter(v => o.reanalyze || !recs.get(v.id)!.vision).map(v => v.id) : []);
    for (const v of videos) if (!needM.has(v.id) && !needV.has(v.id)) setItemStatus(v.id, 'cache');
    updateJob({ step: 'Téléchargement des miniatures et mesures locales…' });
    const visionImgs = new Map<string, VisionImage>();
    await pool(videos.filter(v => needM.has(v.id) || needV.has(v.id)), 4, async v => {
      if (signal.aborted) return;
      const rec = recs.get(v.id)!;
      setItemStatus(v.id, 'image');
      try {
        const vi = await processImage(rec, v.thumbnail, needM.has(v.id), needV.has(v.id), signal);
        if (vi) visionImgs.set(v.id, vi);
        upsertRecords([{ ...rec }]);
        setItemStatus(v.id, vi ? 'vision' : 'ok');
      } catch (e) {
        if (isAbort(e, signal)) return;
        rec.metricsError = errMsg(e); upsertRecords([{ ...rec }]); setItemStatus(v.id, 'erreur', errMsg(e));
      }
      await yieldUi();
    });

    if (visionImgs.size && !signal.aborted) {
      const principles = await thumbnailPrinciples(`miniature efficace ${niche}`, 8);
      if (!principles.length) warn('Base de connaissances vide : les analyses Vision ne citent aucun principe sourcé.');
      const ids = [...visionImgs.keys()];
      for (let i = 0; i < ids.length && !signal.aborted; i += 4) {
        const batch = ids.slice(i, i + 4);
        updateJob({ step: `Analyse Claude Vision (${Math.min(i + batch.length, ids.length)}/${ids.length})…` });
        try {
          const res = await analyzeCompetitors(batch.map(id => { const r = recs.get(id)!; return { image: visionImgs.get(id)!, title: r.title, channel: r.channelTitle, views: r.views, ratio: r.ratio }; }), principles, { signal, fast: o.fast });
          batch.forEach((id, k) => { const r = recs.get(id)!; r.vision = res[k]; r.visionError = undefined; setItemStatus(id, 'ok'); });
        } catch (e) {
          if (isAbort(e, signal)) break;
          const m = errMsg(e);
          batch.forEach(id => { recs.get(id)!.visionError = m; setItemStatus(id, 'erreur', m); });
          if (/clé API|Clé API|invalide|refusé|manquante/i.test(m)) { warn(m); upsertRecords(batch.map(id => ({ ...recs.get(id)! }))); break; }
        }
        upsertRecords(batch.map(id => ({ ...recs.get(id)! })));
      }
    }
    updateJob(j => ({
      status: signal.aborted ? 'annulé' : 'terminé', doneAt: Date.now(), step: signal.aborted ? 'Analyse annulée.' : 'Analyse terminée.',
      items: j.items.map(it => (it.status === 'vision' || it.status === 'attente' || it.status === 'image' || it.status === 'mesures') ? { ...it, status: signal.aborted ? 'attente' : 'ok' } : it),
    }));
  } catch (e) {
    updateJob({ status: isAbort(e, signal) ? 'annulé' : 'erreur', error: isAbort(e, signal) ? undefined : errMsg(e), doneAt: Date.now(), step: isAbort(e, signal) ? 'Analyse annulée.' : 'Échec de l\'analyse.' });
  } finally {
    controller = null;
    await flushLibrary().catch(() => undefined);
  }
}

/** Ré-analyse d'une seule miniature (mesures + Vision). */
export async function reanalyzeOne(videoId: string, withVision = true): Promise<ThumbRecord> {
  const cur = useThumbs.getState().library[videoId];
  if (!cur) throw new Error('Miniature inconnue.');
  const rec: ThumbRecord = { ...cur };
  const vi = await processImage(rec, undefined, true, withVision);
  if (vi) {
    try { rec.vision = (await analyzeCompetitors([{ image: vi, title: rec.title, channel: rec.channelTitle, views: rec.views, ratio: rec.ratio }], await thumbnailPrinciples(`miniature efficace ${rec.niche}`, 8)))[0]; rec.visionError = undefined; }
    catch (e) { rec.visionError = errMsg(e); }
  }
  upsertRecords([rec]); await flushLibrary();
  return rec;
}
