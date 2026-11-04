// Tests A/B titres + miniatures (kv 'abtests') : création, rotation planifiée (alignée sur minuit PT),
// relevé des métriques (Analytics + rapport « Portée »), gagnant + confiance, application et leçons.
// Le planificateur tourne quand l'app est ouverte et rattrape au démarrage (rotation en retard = jour partiel exclu).
import { create } from 'zustand';
import { askClaudeJSON } from '../claude/api';
import { YOUTUBE_SCOPES, youtube } from '../connectors/api';
import { repo, uid } from '../db/store';
import { addPrinciple, type Topic } from '../knowledge/api';
import { confirmAction, toast } from '../ui/appState';
import { evaluateAb, fillPeriods, nextRotationTime, nextVariantIndex, type AbEvaluation } from './abtest';
import { videoUrl } from './metadata';
import { native } from './native';
import { K } from './storage';
import { prepareThumbnail } from './thumbs';
import { addDays, ptDate } from './tz';
import { dailyVideoMetrics, fetchReach, getVideoState, updateVideoTitle } from './youtubeApi';
import type { AbDaily, AbTest, AbVariant, DraftImage, PlannedAbTest } from './types';

export const useAb = create<{ tests: AbTest[]; loaded: boolean; busy: Record<string, string> }>(() => ({ tests: [], loaded: false, busy: {} }));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const letter = (i: number) => String.fromCharCode(65 + i);
const H = 3_600_000;

let loading: Promise<void> | null = null;
export function loadAbTests(): Promise<void> {
  loading ??= (async () => { useAb.setState({ tests: (await repo.kvGet<AbTest[]>(K.abtests)) ?? [], loaded: true }); })();
  return loading;
}
const save = () => repo.kvSet(K.abtests, useAb.getState().tests);
async function update(id: string, f: (t: AbTest) => AbTest) {
  useAb.setState(s => ({ tests: s.tests.map(t => (t.id === id ? f(t) : t)) }));
  await save();
}
const getTest = (id: string) => useAb.getState().tests.find(t => t.id === id);
const log = (t: AbTest, text: string, kind: 'info' | 'error' = 'info'): AbTest => ({ ...t, log: [...t.log, { at: Date.now(), text, kind }].slice(-200) });
const setBusy = (id: string, v?: string) => useAb.setState(s => { const busy = { ...s.busy }; if (v) busy[id] = v; else delete busy[id]; return { busy }; });

// ── Création ─────────────────────────────────────────────────
export interface NewAbTest {
  channelId: string; channelTitle: string; videoId: string; videoTitle: string;
  variants: { title: string; thumbnail?: DraftImage }[];
  intervalHours: number; autoApply: boolean; threshold: number; minImpressions?: number; minDays?: number;
  originalThumbnailUrl?: string;
}
async function toVariants(list: { title: string; thumbnail?: DraftImage }[]): Promise<AbVariant[]> {
  const out: AbVariant[] = [];
  for (const [i, v] of list.entries()) {
    const prepared = v.thumbnail ? await prepareThumbnail(v.thumbnail) : null;
    out.push({ id: uid(), label: letter(i), title: v.title.trim(), ...(prepared ? { thumbnailHash: prepared.hash ?? v.thumbnail?.hash, thumbnailPath: prepared.path } : {}), periods: [] });
  }
  return out;
}

/** Test sur une vidéo déjà en ligne : la variante A est mise en ligne immédiatement (confirmation requise). */
export async function createAbTest(input: NewAbTest): Promise<AbTest | null> {
  await loadAbTests();
  if (input.variants.length < 2) throw new Error('Il faut au moins 2 variantes.');
  if (useAb.getState().tests.some(t => t.videoId === input.videoId && (t.status === 'actif' || t.status === 'planifie'))) throw new Error('Un test est déjà en cours sur cette vidéo.');
  const ok = await confirmAction(`Lancer un test A/B sur « ${input.videoTitle} » ?\n\nPrisme modifiera automatiquement le titre et/ou la miniature de la vidéo sur YouTube toutes les ${input.intervalHours} h (à minuit, heure du Pacifique)${input.autoApply ? ', puis appliquera la variante gagnante' : ''}.`, { confirmLabel: 'Lancer le test' });
  if (!ok) return null;
  const now = Date.now();
  const test: AbTest = {
    id: uid(), videoId: input.videoId, channelId: input.channelId, channelTitle: input.channelTitle, videoTitle: input.videoTitle,
    variants: await toVariants(input.variants), status: 'actif', intervalHours: Math.max(24, input.intervalHours), autoApply: input.autoApply,
    threshold: input.threshold, minImpressions: input.minImpressions ?? 1000, minDaysPerVariant: input.minDays ?? 3, current: 0, startAt: now,
    createdAt: now, originalTitle: input.videoTitle, originalThumbnailUrl: input.originalThumbnailUrl, log: [],
  };
  useAb.setState(s => ({ tests: [test, ...s.tests] }));
  await save();
  await startTest(test.id, true);
  void fetchReach(test.channelId, [test.videoId], ptDate(now)).catch(() => undefined); // crée la tâche « Portée » au plus tôt
  return getTest(test.id) ?? null;
}

/** Test préparé à la publication : démarre quand la vidéo devient publique (startAt) — la variante A est celle publiée. */
export async function createPlannedAbTest(p: { channelId: string; channelTitle: string; videoId: string; videoTitle: string; plan: PlannedAbTest; startAt?: number; originalThumbnail?: DraftImage }) {
  await loadAbTests();
  const variants = await toVariants(p.plan.variants.map((v, i) => ({ title: v.title || p.videoTitle, thumbnail: v.thumbnail ?? (i === 0 ? p.originalThumbnail : undefined) })));
  const test: AbTest = {
    id: uid(), videoId: p.videoId, channelId: p.channelId, channelTitle: p.channelTitle, videoTitle: p.videoTitle, variants,
    status: 'planifie', intervalHours: Math.max(24, p.plan.intervalHours), autoApply: p.plan.autoApply, threshold: p.plan.threshold,
    minImpressions: 1000, minDaysPerVariant: 3, current: 0, startAt: p.startAt ?? 0, createdAt: Date.now(), originalTitle: p.videoTitle,
    log: [{ at: Date.now(), text: p.startAt ? `Démarrage prévu le ${new Date(p.startAt).toLocaleString('fr-FR')}.` : 'Démarrera quand la vidéo sera publique.' }],
  };
  useAb.setState(s => ({ tests: [test, ...s.tests] }));
  await save();
  void fetchReach(p.channelId, [p.videoId], ptDate(Date.now())).catch(() => undefined);
}

// ── Rotation ─────────────────────────────────────────────────
async function applyVariant(t: AbTest, idx: number, prevIdx: number | null) {
  const v = t.variants[idx]; const prev = prevIdx != null ? t.variants[prevIdx] : null;
  if (v.title && (!prev || prev.title !== v.title)) await updateVideoTitle(t.channelId, t.videoId, v.title);
  if (v.thumbnailPath && (!prev || prev.thumbnailHash !== v.thumbnailHash || !prev.thumbnailPath)) {
    await native.thumbnailSet(t.videoId, v.thumbnailPath, await youtube.token(t.channelId, [YOUTUBE_SCOPES.upload]));
    void youtube.trackQuota('thumbnails.set').catch(() => undefined);
  }
}

async function startTest(id: string, applyFirst: boolean) {
  const t = getTest(id); if (!t) return;
  const now = Date.now();
  try {
    if (applyFirst) await applyVariant(t, 0, null);
    await update(id, x => log({ ...x, status: 'actif', current: 0, lastRotationAt: now, nextRotationAt: nextRotationTime(now, x.intervalHours), variants: x.variants.map((v, i) => (i === 0 ? { ...v, periods: [...v.periods, { start: now }] } : v)) }, `Variante A en ligne. Prochaine rotation : ${new Date(nextRotationTime(now, t.intervalHours)).toLocaleString('fr-FR')}.`));
  } catch (e) { await update(id, x => log(x, `Démarrage impossible : ${errMsg(e)}`, 'error')); throw e; }
}

async function rotate(id: string) {
  const t = getTest(id); if (!t || t.status !== 'actif') return;
  const next = nextVariantIndex(t.current, t.variants.length);
  const now = Date.now();
  setBusy(id, 'Rotation…');
  try {
    await applyVariant(t, next, t.current);
    await update(id, x => log({
      ...x, current: next, lastRotationAt: now, nextRotationAt: nextRotationTime(now, x.intervalHours),
      variants: x.variants.map((v, i) => ({ ...v, periods: i === x.current ? v.periods.map((p, k) => (k === v.periods.length - 1 && p.end == null ? { ...p, end: now } : p)) : i === next ? [...v.periods, { start: now }] : v.periods })),
    }, `Rotation : variante ${letter(next)} en ligne.`));
  } catch (e) {
    await update(id, x => log({ ...x, nextRotationAt: now + H }, `Rotation impossible (${errMsg(e)}) — nouvel essai dans 1 h.`, 'error'));
  } finally { setBusy(id); }
}

// ── Métriques, gagnant, application ──────────────────────────
export function evaluation(t: AbTest, now = Date.now()): AbEvaluation {
  const cutoff = addDays(ptDate(now), -2); // les 2 derniers jours ne sont pas encore consolidés par YouTube
  return evaluateAb(t.variants, (t.daily ?? []).filter(d => d.date <= cutoff), { now, threshold: t.threshold, minImpressions: t.minImpressions, minDays: t.minDaysPerVariant });
}

export async function refreshMetrics(id: string, opts: { silent?: boolean } = {}) {
  const t = getTest(id); if (!t || !t.startAt) return;
  setBusy(id, 'Relevé des statistiques…');
  const from = ptDate(t.startAt); const to = ptDate(Date.now());
  let note = '';
  try {
    const days = await dailyVideoMetrics(t.channelId, t.videoId, from, to);
    let reach = new Map<string, { impressions: number; ctr: number }>();
    try { reach = await fetchReach(t.channelId, [t.videoId], from); }
    catch (e) { note = `CTR indisponible (${errMsg(e)}) : comparaison sur les vues/jour.`; }
    if (!note && !reach.size) note = 'Rapport « Portée » (impressions/CTR) pas encore généré par YouTube (≈ 48 h après sa création) : comparaison provisoire sur les vues/jour.';
    const daily: AbDaily[] = days.map(d => { const r = reach.get(`${t.videoId}|${d.date}`); return { ...d, ...(r ? { impressions: r.impressions, ctr: r.ctr } : {}) }; });
    const now = Date.now();
    await update(id, x => ({ ...x, daily, lastMetricsAt: now, metricsNote: note || undefined, variants: fillPeriods(x.variants, daily, now) }));
    await maybeConclude(id);
  } catch (e) {
    await update(id, x => log({ ...x, lastMetricsAt: Date.now() }, `Statistiques indisponibles : ${errMsg(e)}`, 'error'));
    if (!opts.silent) toast(`Test A/B : ${errMsg(e)}`, 'error');
  } finally { setBusy(id); }
}

async function maybeConclude(id: string) {
  const t = getTest(id); if (!t || t.status !== 'actif') return;
  const ev = evaluation(t);
  if (!ev.ready || ev.winnerIndex == null) return;
  const w = t.variants[ev.winnerIndex];
  if (!t.winner || t.winner.variantId !== w.id) {
    await update(id, x => log({ ...x, winner: { index: ev.winnerIndex!, variantId: w.id, thumbnailHash: w.thumbnailHash, title: w.title, confidence: ev.confidence, metric: ev.metric, decidedAt: Date.now(), applied: false, lift: ev.lift } },
      `Gagnant : variante ${w.label} (${ev.metric === 'ctr' ? 'CTR' : 'vues/jour'} +${Math.round(ev.lift * 100)} %, confiance ${Math.round(ev.confidence * 100)} %).`));
  }
  if (t.autoApply) await applyWinner(id, true);
  else toast(`Test A/B « ${t.videoTitle} » : la variante ${w.label} gagne (confiance ${Math.round(ev.confidence * 100)} %). Applique-la depuis Publication → Tests A/B.`, 'success');
}

/** Applique la variante gagnante définitivement et clôt le test (confirmation sauf application automatique autorisée). */
export async function applyWinner(id: string, auto = false) {
  const t = getTest(id); if (!t?.winner) return;
  const idx = t.variants.findIndex(v => v.id === t.winner!.variantId);
  if (idx < 0) return;
  if (!auto && !(await confirmAction(`Appliquer définitivement la variante ${t.variants[idx].label} (« ${t.variants[idx].title} ») sur YouTube et terminer le test ?`, { confirmLabel: 'Appliquer' }))) return;
  setBusy(id, 'Application du gagnant…');
  try {
    if (idx !== t.current) await applyVariant(t, idx, t.current);
    const now = Date.now();
    await update(id, x => log({ ...x, status: 'termine', endedAt: now, current: idx, winner: { ...x.winner!, applied: true }, variants: x.variants.map(v => ({ ...v, periods: v.periods.map(p => (p.end == null ? { ...p, end: now } : p)) })) }, `Variante ${t.variants[idx].label} appliquée${auto ? ' automatiquement' : ''}. Test terminé.`));
    await addLesson(id);
    toast(`Test A/B terminé : variante ${t.variants[idx].label} appliquée.`, 'success');
  } catch (e) { await update(id, x => log(x, `Application impossible : ${errMsg(e)}`, 'error')); toast(errMsg(e), 'error'); }
  finally { setBusy(id); }
}

/** Arrête le test en gardant la variante choisie (index) en ligne. */
export async function stopAbTest(id: string, keepIndex: number) {
  const t = getTest(id); if (!t) return;
  if (!(await confirmAction(`Arrêter le test et garder la variante ${t.variants[keepIndex]?.label ?? 'A'} en ligne ?`, { confirmLabel: 'Arrêter le test' }))) return;
  setBusy(id, 'Arrêt…');
  try {
    if (t.status === 'actif' && keepIndex !== t.current) await applyVariant(t, keepIndex, t.current);
    const now = Date.now();
    await update(id, x => log({ ...x, status: 'arrete', endedAt: now, current: keepIndex, variants: x.variants.map(v => ({ ...v, periods: v.periods.map(p => (p.end == null ? { ...p, end: now } : p)) })) }, `Test arrêté, variante ${x.variants[keepIndex]?.label} conservée.`));
  } catch (e) { toast(errMsg(e), 'error'); }
  finally { setBusy(id); }
}
export async function deleteAbTest(id: string) {
  if (!(await confirmAction('Supprimer ce test de l’historique ?', { danger: true, confirmLabel: 'Supprimer' }))) return;
  useAb.setState(s => ({ tests: s.tests.filter(t => t.id !== id) })); await save();
}

/** Leçon ajoutée à la base de connaissances (source « ab-test »), formulée par Claude si disponible. */
async function addLesson(id: string) {
  const t = getTest(id); if (!t?.winner || t.lessonAdded) return;
  const ev = evaluation(t, t.endedAt ?? Date.now());
  const w = t.variants.find(v => v.id === t.winner!.variantId)!;
  const titlesDiffer = new Set(t.variants.map(v => v.title)).size > 1;
  const thumbsDiffer = new Set(t.variants.map(v => v.thumbnailHash ?? '')).size > 1;
  const topic: Topic = titlesDiffer && thumbsDiffer ? 'packaging' : thumbsDiffer ? 'thumbnail' : 'title';
  const metric = t.winner.metric === 'ctr' ? 'CTR des impressions' : 'vues par jour (tendance retirée)';
  const rows = ev.stats.map(s => `${s.label} « ${t.variants.find(v => v.id === s.id)?.title} »${t.variants.find(v => v.id === s.id)?.thumbnailHash ? ' (miniature ' + s.label + ')' : ''} : ${s.ctr != null ? (s.ctr * 100).toFixed(2) + ' % de CTR sur ' + Math.round(s.impressions) + ' impressions, ' : ''}${Math.round(s.viewsPerDay)} vues/jour, ${s.nDays} jours`).join('\n');
  const factual = `Sur « ${t.videoTitle} », la variante ${w.label} (« ${w.title} ») a gagné : ${metric} +${Math.round(t.winner.lift * 100)} %, confiance ${Math.round(t.winner.confidence * 100)} %.\n${rows}`;
  let lesson = { title: `Test A/B : « ${w.title.slice(0, 60)} » +${Math.round(t.winner.lift * 100)} %`, text: factual };
  try {
    const r = await askClaudeJSON<{ title: string; text: string }>({
      fast: true, maxTokens: 600,
      system: 'Tu es analyste YouTube. À partir d’un test A/B réel, formule UNE leçon de packaging réutilisable, en français, prudente (un seul test, pas de généralisation abusive). JSON : {"title": "≤ 80 caractères", "text": "2-3 phrases : ce qui a gagné, l’hypothèse explicative, comment l’appliquer"}.',
      prompt: `${topic === 'title' ? 'Seuls les titres changeaient.' : topic === 'thumbnail' ? 'Seules les miniatures changeaient.' : 'Titres et miniatures changeaient.'}\n${factual}`,
    });
    if (r?.title && r?.text) lesson = { title: r.title.slice(0, 120), text: `${r.text}\n\nDonnées : ${factual}` };
  } catch { /* leçon factuelle */ }
  try {
    await addPrinciple({ topic, title: lesson.title, text: lesson.text, source: { creator: t.channelTitle || 'Ma chaîne', videoId: t.videoId, videoTitle: t.videoTitle, url: videoUrl(t.videoId), kind: 'ab-test' } });
    await update(id, x => log({ ...x, lessonAdded: true }, 'Leçon ajoutée à la base de connaissances.'));
  } catch (e) { await update(id, x => log(x, `Leçon non enregistrée : ${errMsg(e)}`, 'error')); }
}

// ── Planificateur ────────────────────────────────────────────
let ticking = false; let timer: ReturnType<typeof setInterval> | null = null;
export async function abTick() {
  if (ticking) return; ticking = true;
  try {
    await loadAbTests();
    const now = Date.now();
    for (const t of [...useAb.getState().tests]) {
      try {
        if (t.status === 'planifie') {
          if (t.startAt && now < t.startAt) continue;
          if (now - (t.lastMetricsAt ?? 0) < 6 * H && !t.startAt) continue;
          const st = await getVideoState(t.channelId, t.videoId).catch(() => null);
          if (st?.privacyStatus === 'public') { await update(t.id, x => ({ ...x, startAt: x.startAt || now })); await startTest(t.id, false); }
          else await update(t.id, x => ({ ...x, lastMetricsAt: now }));
        } else if (t.status === 'actif') {
          if (t.nextRotationAt && now >= t.nextRotationAt) await rotate(t.id);
          if (now - (t.lastMetricsAt ?? 0) >= 6 * H) await refreshMetrics(t.id, { silent: true });
        }
      } catch (e) { console.warn('Test A/B', t.id, errMsg(e)); }
    }
  } finally { ticking = false; }
}
export function startAbScheduler() {
  if (timer) return;
  setTimeout(() => { void abTick(); }, 15_000);  // rattrapage au démarrage
  timer = setInterval(() => { void abTick(); }, 5 * 60_000);
}
