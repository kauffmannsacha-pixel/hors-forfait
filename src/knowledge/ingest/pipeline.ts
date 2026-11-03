// « Mettre à jour les connaissances » : file vérifiée + chaînes suivies + recherches par sujet → transcription →
// fenêtres horodatées → extraction Claude → dédoublonnage → index. Progression détaillée, annulable, quota respecté.
import { youtube, type YtVideo } from '../../connectors/api';
import { isAbortError } from '../../claude/api';
import { secrets } from '../../db/secrets';
import { repo } from '../../db/store';
import { engine } from '../engine';
import { getSettings, KV, saveSettings } from '../settings';
import { runJob, type JobHandle } from '../job';
import { QuotaExceededError, QuotaGuard, YT_COST } from './quota';
import { transcriptChain } from '../transcript/service';
import { TranscriptUnavailableError } from '../transcript/chain';
import { findTranscriptTool } from '../transcript/providers';
import { chunkTranscript, truncateSegments } from '../transcript/chunk';
import { extractPrinciples } from './extract';
import { relevanceScore } from '../text';
import type { CreatorConfig, KnSettings, KnSource, SourceStatus, UpdateReport, VideoMeta } from '../types';

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const RETRY_NO_TRANSCRIPT_MS = 30 * 24 * 3600e3;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notConnected = (e: unknown) => /n'est pas connecté|not connected|clé api youtube/i.test(msg(e));

/** Faut-il (re)traiter cette vidéo ? */
export function shouldProcess(src: KnSource | undefined, now = Date.now()): boolean {
  if (!src) return true;
  if (src.status === 'ok' || src.status === 'empty') return false;
  if (src.attempts >= 3) return false;
  if (src.status === 'no-transcript') return now - src.updatedAt > RETRY_NO_TRANSCRIPT_MS;
  return true;
}

export interface Prerequisites { claude: boolean; youtube: boolean; mcpTool: string | null; ok: boolean; reason?: string }
export async function checkPrerequisites(): Promise<Prerequisites> {
  const claude = !!(await secrets.get('anthropic_api_key').catch(() => null));
  const channels = await youtube.channels().catch(() => []);
  const tool = await findTranscriptTool(true).catch(() => null);
  const ok = claude && (channels.length > 0 || !!tool);
  return {
    claude, youtube: channels.length > 0, mcpTool: tool ? `${tool.server} › ${tool.name}` : null, ok,
    reason: !claude ? 'Clé API Anthropic manquante (Réglages → Claude).' : !ok ? 'Connecte YouTube (Réglages → Connexions) ou un serveur MCP de transcription.' : undefined,
  };
}

function newGuard(s: KnSettings) {
  return new QuotaGuard(s.quotaBudget, s.dailyQuota, {
    used: () => youtube.quotaUsedToday(),
    buckets: async () => {
      const q = await youtube.quota();
      return { buckets: q.buckets.map(b => ({ id: b.id, used: b.used, limit: b.limit, unit: b.unit })), reserve: q.reserve || undefined };
    },
  });
}

/** Résout l'ID de chaîne d'un créateur (ID connu → @handle → recherche) et le mémorise dans les réglages. */
async function resolveCreator(c: CreatorConfig, guard: QuotaGuard): Promise<CreatorConfig> {
  if (c.channelId) return c;
  let found: { id: string; title: string; thumb?: string } | null = null;
  if (c.handle) {
    type R = { items?: { id: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[] };
    const r = await guard.run('default', YT_COST.channels, `chaîne ${c.handle}`, () => youtube.data<R>('channels', { part: 'snippet', forHandle: c.handle! }));
    const it = r.items?.[0];
    if (it) found = { id: it.id, title: it.snippet?.title ?? c.name, thumb: it.snippet?.thumbnails?.default?.url };
  }
  if (!found) {
    const r = await guard.run('search', YT_COST.search, `recherche de la chaîne ${c.name}`, () => youtube.search(c.name, { type: 'channel', max: 1 }));
    const it = r[0];
    if (it) found = { id: it.channelId || it.id, title: it.channelTitle || it.title, thumb: it.thumbnail };
  }
  if (!found) return c;
  const next: CreatorConfig = { ...c, channelId: found.id, resolvedTitle: found.title, thumbnail: found.thumb ?? c.thumbnail };
  const s = await getSettings();
  await saveSettings({ creators: s.creators.map(x => (x.id === c.id ? next : x)) });
  return next;
}

const toMeta = (v: YtVideo, creator: string, priority: number, origin: VideoMeta['origin']): VideoMeta => ({
  videoId: v.id, title: v.title, creator, channelId: v.channelId, channelTitle: v.channelTitle, durationSec: v.durationSec || undefined,
  views: v.views || undefined, publishedAt: v.publishedAt, priority, origin,
});

/** Vidéos candidates, triées par priorité (file vérifiée d'abord). */
async function discover(s: KnSettings, guard: QuotaGuard, h: JobHandle): Promise<VideoMeta[]> {
  const now = Date.now();
  const cands = new Map<string, VideoMeta>();
  const okDuration = (v: YtVideo) => !v.durationSec || v.durationSec >= s.minDurationSec;

  for (const sv of await engine.seedQueue()) {
    if (shouldProcess(engine.source('yt:' + sv.videoId), now)) cands.set(sv.videoId, { ...sv, priority: 1000 - cands.size, origin: 'queue' });
  }
  if (cands.size) h.log('info', `File d'attente vérifiée : ${cands.size} vidéo(s) à analyser`);

  const creators = s.creators.filter(c => c.enabled);
  const followed = new Map<string, string>();
  let youtubeOk = true;
  h.phase('Chaînes des créateurs suivis', creators.length);
  for (const [i, c0] of creators.entries()) {
    if (h.signal.aborted) return [];
    h.step(i, c0.name);
    try {
      const c = await resolveCreator(c0, guard);
      h.quota(guard.spent, s.quotaBudget);
      if (!c.channelId) { h.log('warn', `${c.name} : chaîne introuvable — corrige-la dans Réglages → Base de connaissances.`); continue; }
      followed.set(c.channelId, c.name);
      const vids = await guard.run('default', YT_COST.channelVideos, `vidéos de ${c.name}`, () => youtube.channelVideos(c.channelId!, { max: s.videosPerCreator, order: 'date' }));
      let kept = 0;
      for (const v of vids) {
        if (!okDuration(v) || !shouldProcess(engine.source('yt:' + v.id), now) || cands.has(v.id)) continue;
        const rel = relevanceScore(v.title, v.description);
        if (rel < 2) continue;
        cands.set(v.id, toMeta(v, c.name, 100 + rel * 10 + Math.log10((v.views || 0) + 10), 'creator')); kept++;
      }
      h.log('info', `${c.name} : ${vids.length} vidéo(s) récente(s), ${kept} sur la création YouTube`);
    } catch (e) {
      if (isAbortError(e)) throw e;
      if (e instanceof QuotaExceededError) { h.log('warn', e.message); break; }
      if (notConnected(e)) { youtubeOk = false; h.log('warn', 'YouTube non connecté : seule la file d\'attente vérifiée sera analysée (Réglages → Connexions).'); break; }
      h.log('warn', `${c0.name} : ${msg(e)}`);
    }
    h.quota(guard.spent, s.quotaBudget);
  }
  h.step(creators.length);

  const queries = s.queries.filter(q => q.enabled && q.query.trim());
  if (youtubeOk && queries.length) {
    h.phase('Recherche par sujet', queries.length);
    for (const [i, q] of queries.entries()) {
      if (h.signal.aborted) return [];
      h.step(i, q.query);
      try {
        const res = await guard.run('search', YT_COST.search, `recherche « ${q.query} »`, () => youtube.search(q.query, { max: s.resultsPerQuery, order: 'relevance', type: 'video' }));
        let kept = 0;
        for (const v of res) {
          if (cands.has(v.id) || !okDuration(v) || !shouldProcess(engine.source('yt:' + v.id), now)) continue;
          if (v.views && v.views < s.minViews) continue;
          const isFollowed = followed.has(v.channelId);
          if (s.onlyFollowed && !isFollowed) continue;
          const rel = relevanceScore(v.title, v.description);
          if (rel < 1) continue;
          cands.set(v.id, toMeta(v, followed.get(v.channelId) ?? v.channelTitle, 50 + (isFollowed ? 40 : 0) + rel * 5 + Math.log10((v.views || 0) + 10), 'search'));
          kept++;
        }
        h.log('info', `« ${q.query} » : ${res.length} résultat(s), ${kept} retenu(s)`);
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (e instanceof QuotaExceededError) { h.log('warn', e.message); break; }
        if (notConnected(e)) { h.log('warn', 'YouTube non connecté : recherches par sujet ignorées.'); break; }
        h.log('warn', `« ${q.query} » : ${msg(e)}`);
      }
      h.quota(guard.spent, s.quotaBudget);
    }
    h.step(queries.length);
  }
  return [...cands.values()].sort((a, b) => b.priority - a.priority);
}

export interface IngestResult { status: SourceStatus; added: number; duplicates: number; detail?: string }

/** Analyse une vidéo : transcription (chaîne de fournisseurs) → fenêtres → extraction → ajout dédoublonné. */
export async function ingestVideo(v: VideoMeta, h: JobHandle, opts: { guard?: QuotaGuard; refresh?: boolean } = {}): Promise<IngestResult> {
  const s = await getSettings();
  const id = 'yt:' + v.videoId;
  const prev = engine.source(id);
  const now = Date.now();
  const base: KnSource = {
    id, kind: 'youtube', creator: v.creator, videoId: v.videoId, title: v.title, url: watchUrl(v.videoId), channelId: v.channelId, channelTitle: v.channelTitle,
    durationSec: v.durationSec, views: v.views, publishedAt: v.publishedAt, status: 'error', principles: prev?.principles ?? 0,
    attempts: (prev?.attempts ?? 0) + 1, createdAt: prev?.createdAt ?? now, updatedAt: now,
  };
  h.log('info', `▶ ${v.creator} — « ${v.title} »`);
  let transcript;
  try {
    transcript = await transcriptChain(v.videoId, {
      channelId: v.channelId, signal: h.signal, refresh: opts.refresh,
      beforeCall: opts.guard ? (cost, label) => opts.guard!.guardExternal(cost, label) : undefined,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    const status: SourceStatus = e instanceof TranscriptUnavailableError ? 'no-transcript' : 'error';
    await engine.upsertSource({ ...base, status, detail: msg(e) });
    h.log('warn', `  Pas de transcription : ${msg(e)}`);
    return { status, added: 0, duplicates: 0, detail: msg(e) };
  }
  h.sub(0.12);
  const timed = transcript.timed !== false;
  const segs = truncateSegments(transcript.segments, s.maxMinutesPerVideo * 60);
  const truncated = segs.length < transcript.segments.length;
  const windows = chunkTranscript(segs);
  h.log('info', `  Transcription (${providerLabel(transcript.provider)}) : ${transcript.segments.length} segments → ${windows.length} fenêtre(s) de ~75 s${truncated ? ` (tronquée à ${s.maxMinutesPerVideo} min)` : ''}${timed ? '' : ' — sans horodatage'}`);
  try {
    const extracted = await extractPrinciples({ creator: v.creator, title: v.title }, windows, { timed, signal: h.signal, onBatch: (d, t) => h.sub(0.12 + 0.83 * d / t) });
    const res = await engine.addPrinciples(extracted.map(e => ({
      topic: e.topic, title: e.title, text: e.text, origin: 'ingest' as const, sourceId: id,
      source: { kind: 'youtube' as const, creator: v.creator, videoId: v.videoId, videoTitle: v.title, url: watchUrl(v.videoId), ...(timed && e.timestamp != null ? { timestamp: e.timestamp } : {}) },
    })));
    const total = engine.list().filter(p => p.sourceId === id).length;
    const status: SourceStatus = total ? 'ok' : 'empty';
    await engine.upsertSource({ ...base, status, provider: transcript.provider, principles: total, detail: truncated ? `Analyse limitée aux ${s.maxMinutesPerVideo} premières minutes.` : undefined, updatedAt: Date.now() });
    h.log('ok', `  ${res.added.length} principe(s) ajouté(s)${res.duplicates.length ? `, ${res.duplicates.length} doublon(s) écarté(s)` : ''}`);
    h.sub(1);
    return { status, added: res.added.length, duplicates: res.duplicates.length };
  } catch (e) {
    if (isAbortError(e)) throw e;
    await engine.upsertSource({ ...base, status: 'error', provider: transcript.provider, detail: msg(e) });
    h.log('error', `  Extraction impossible : ${msg(e)}`);
    return { status: 'error', added: 0, duplicates: 0, detail: msg(e) };
  }
}

export const providerLabel = (p: string) => (p === 'youtube-captions' ? 'sous-titres officiels' : p === 'mcp' ? 'outil MCP' : 'import manuel');

/** Mise à jour complète (bouton ou hebdomadaire). */
export function runUpdate(opts: { auto?: boolean } = {}): Promise<UpdateReport> {
  return runJob('update', opts.auto ? 'Mise à jour automatique des connaissances' : 'Mise à jour des connaissances', async (h) => {
    const report: UpdateReport = { startedAt: Date.now(), finishedAt: 0, auto: !!opts.auto, cancelled: false, videos: 0, principles: 0, duplicates: 0, noTranscript: 0, errors: 0, quotaUsed: 0, messages: [] };
    await engine.init();
    await repo.kvSet(KV.lastAttempt, report.startedAt);
    const s = await getSettings();
    if (!(await secrets.get('anthropic_api_key').catch(() => null))) throw new Error('Clé API Anthropic manquante — ajoute-la dans Réglages → Claude.');
    const guard = newGuard(s);
    h.quota(0, s.quotaBudget);
    h.phase('Recherche des vidéos');
    let selected: VideoMeta[] = [];
    try {
      const cands = await discover(s, guard, h);
      selected = cands.slice(0, s.maxVideosPerUpdate);
      h.log('info', `${cands.length} vidéo(s) candidate(s) — ${selected.length} analysée(s) maintenant${cands.length > selected.length ? `, ${cands.length - selected.length} à la prochaine mise à jour` : ''}`);
    } catch (e) {
      if (!isAbortError(e)) throw e;
    }
    if (!h.signal.aborted && selected.length) {
      h.phase('Transcription et extraction des principes', selected.length);
      for (const [i, v] of selected.entries()) {
        if (h.signal.aborted) break;
        h.step(i, `${v.creator} — ${v.title}`);
        try {
          const r = await ingestVideo(v, h, { guard });
          if (r.status === 'ok' || r.status === 'empty') report.videos++;
          else if (r.status === 'no-transcript') report.noTranscript++;
          else report.errors++;
          report.principles += r.added; report.duplicates += r.duplicates;
          h.counts(report.principles, report.duplicates);
        } catch (e) {
          if (isAbortError(e)) break;
          report.errors++;
          h.log('error', `  ${msg(e)}`);
        }
        h.quota(guard.spent, s.quotaBudget);
      }
      h.step(selected.length);
    }
    if (!h.signal.aborted && s.semantic) {
      h.phase('Indexation sémantique locale');
      try {
        const once = !!(await repo.kvGet<boolean>(KV.modelReadyOnce));
        const n = await engine.ensureIndex({ download: !opts.auto || once, signal: h.signal });
        if (n) h.log('ok', `${n} principe(s) indexé(s)`);
      } catch (e) { if (!isAbortError(e)) h.log('warn', `Index sémantique : ${msg(e)} — recherche par mots-clés en attendant.`); }
    }
    report.cancelled = h.signal.aborted;
    report.quotaUsed = guard.spent;
    report.finishedAt = Date.now();
    if (report.cancelled) h.log('warn', 'Mise à jour annulée.');
    else h.log('ok', `Terminé : ${report.principles} principe(s) ajouté(s) depuis ${report.videos} vidéo(s)${report.noTranscript ? `, ${report.noTranscript} sans transcription` : ''}${report.errors ? `, ${report.errors} erreur(s)` : ''}.`);
    if (!report.cancelled && (report.videos > 0 || selected.length === 0)) await repo.kvSet(KV.lastUpdate, report.finishedAt);
    await repo.kvSet(KV.lastReport, report);
    return report;
  });
}

/** Analyse une seule vidéo (bouton « Réessayer » ou après un import manuel de transcription). */
export function runSingleVideo(v: VideoMeta, opts: { refresh?: boolean } = {}): Promise<IngestResult> {
  return runJob('video', `Analyse de « ${v.title} »`, async (h) => {
    await engine.init();
    if (!(await secrets.get('anthropic_api_key').catch(() => null))) throw new Error('Clé API Anthropic manquante — ajoute-la dans Réglages → Claude.');
    h.phase('Transcription et extraction des principes', 1);
    h.step(0, `${v.creator} — ${v.title}`);
    const s = await getSettings();
    const r = await ingestVideo(v, h, { refresh: opts.refresh, guard: newGuard(s) });
    h.step(1);
    h.counts(r.added, r.duplicates);
    if (s.semantic && r.added) await engine.ensureIndex({ download: false }).catch(() => undefined);
    return r;
  });
}
