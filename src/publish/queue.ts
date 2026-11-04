// File d'envoi persistée (kv 'publish:queue') : envoi reprenable par morceaux de 8 Mio, reprise automatique
// (coupure réseau, redémarrage de l'app), renouvellement du jeton, attente exponentielle, finalisation
// (miniature, sous-titres, playlists, carte kanban, test A/B) et historique.
import { create } from 'zustand';
import { YOUTUBE_SCOPES, youtube } from '../connectors/api';
import { repo, uid } from '../db/store';
import { confirmAction, toast } from '../ui/appState';
import { createPlannedAbTest } from './abRunner';
import { SpeedMeter, backoffDelay, planChunk } from './chunks';
import { markIdeaPublished } from './ideas';
import { buildVideoResource, effectivePrivacy, hasBlocking, validateDraft, videoUrl } from './metadata';
import { native, onUploadProgress, type UploadStep } from './native';
import { K, recordPublished } from './storage';
import { prepareThumbnail } from './thumbs';
import { addToPlaylist } from './youtubeApi';
import type { LiveStats, PostStep, QueueItem, VideoDraft } from './types';

interface QueueState { items: QueueItem[]; live: Record<string, LiveStats>; loaded: boolean; working: string | null }
export const useQueue = create<QueueState>(() => ({ items: [], live: {}, loaded: false, working: null }));

const MAX_RETRIES = 9;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const getItem = (id: string) => useQueue.getState().items.find(i => i.id === id);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist(immediate = false) {
  if (saveTimer) clearTimeout(saveTimer);
  const run = () => { saveTimer = null; void repo.kvSet(K.queue, useQueue.getState().items); };
  if (immediate) run(); else saveTimer = setTimeout(run, 500);
}
function patch(id: string, p: Partial<QueueItem> | ((it: QueueItem) => Partial<QueueItem>), immediate = true) {
  useQueue.setState(s => ({ items: s.items.map(i => (i.id === id ? { ...i, ...(typeof p === 'function' ? p(i) : p) } : i)) }));
  persist(immediate);
}
function setLive(id: string, l: Partial<LiveStats>) {
  const base: LiveStats = { bytesPerSec: 0, etaSec: null, sent: 0, updatedAt: Date.now() };
  useQueue.setState(s => ({ live: { ...s.live, [id]: { ...base, ...(s.live[id] ?? {}), ...l } } }));
}

// ── Jetons OAuth (renouvelés à la demande) ───────────────────
class TokenCache {
  private tok: string | null = null; private at = 0;
  constructor(private channelId: string, private scopes: string[]) {}
  async get() { if (!this.tok || Date.now() - this.at > 40 * 60_000) { this.tok = await youtube.token(this.channelId, this.scopes); this.at = Date.now(); } return this.tok; }
  invalidate() { this.tok = null; }
}

// ── Progression fine (événements Rust) ───────────────────────
const meters = new Map<string, SpeedMeter>();
let progressBound = false;
async function bindProgress() {
  if (progressBound) return; progressBound = true;
  await onUploadProgress(p => {
    const it = useQueue.getState().items.find(i => i.uploadUrl === p.uploadUrl);
    if (!it) return;
    const sent = p.offset + p.sent;
    const m = meters.get(it.id) ?? new SpeedMeter(); meters.set(it.id, m);
    m.add(sent);
    const prev = useQueue.getState().live[it.id];
    if (prev && Date.now() - prev.updatedAt < 200 && p.sent < p.len) return;
    setLive(it.id, { sent, bytesPerSec: m.bytesPerSec(), etaSec: m.eta(p.total - sent), updatedAt: Date.now(), phase: 'Envoi' });
  });
}

// ── Chargement / reprise au démarrage ────────────────────────
let loading: Promise<void> | null = null;
export function loadQueue(): Promise<void> {
  loading ??= (async () => {
    const saved = (await repo.kvGet<QueueItem[]>(K.queue)) ?? [];
    // Un envoi interrompu par la fermeture de l'app reprend tout seul (la confirmation a déjà été donnée).
    const items = saved.map(i => (i.state === 'envoi' || i.state === 'finalisation' ? { ...i, state: 'attente' as const } : i));
    useQueue.setState({ items, loaded: true });
    await bindProgress().catch(() => undefined);
    if (items.some(i => i.state === 'attente')) kickWorker();
  })();
  return loading;
}

// ── Demande de publication (validation + confirmation obligatoire) ──
export interface PublishContext { channelTitle: string; description: string }
const privacyLabel = { private: 'privée', unlisted: 'non répertoriée', public: 'publique' } as const;

export async function requestPublish(draft: VideoDraft, ctx: PublishContext): Promise<QueueItem | null> {
  const issues = validateDraft(draft, { description: ctx.description });
  if (hasBlocking(issues)) { toast(issues.filter(i => i.level === 'error').map(i => i.message).join(' · '), 'error'); return null; }
  const priv = effectivePrivacy(draft);
  const when = draft.scheduleAt ? new Date(draft.scheduleAt).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  const msg = draft.scheduleAt
    ? `Programmer « ${draft.title} » sur « ${ctx.channelTitle} » pour le ${when} ?\n\nLa vidéo est envoyée maintenant en privé, puis deviendra PUBLIQUE automatiquement à cette date${draft.notifySubscribers ? ' (les abonnés seront notifiés)' : ''}.`
    : priv === 'public'
      ? `Publier « ${draft.title} » en PUBLIC sur « ${ctx.channelTitle} » ?\n\nElle sera visible par tout le monde dès la fin de l'envoi${draft.notifySubscribers ? ' et tes abonnés seront notifiés' : ''}.`
      : `Mettre en ligne « ${draft.title} » sur « ${ctx.channelTitle} » en ${privacyLabel[priv]} ?`;
  const ok = await confirmAction(msg, { danger: priv === 'public' || !!draft.scheduleAt, confirmLabel: draft.scheduleAt ? 'Programmer' : priv === 'public' ? 'Publier' : 'Mettre en ligne' });
  if (!ok) return null;
  return enqueue(draft, ctx);
}

function initialSteps(d: VideoDraft): PostStep[] {
  const steps: PostStep[] = [];
  if (d.thumbnail) steps.push({ id: uid(), kind: 'thumbnail', label: 'Miniature', state: 'todo' });
  for (const c of d.captions) steps.push({ id: uid(), kind: 'caption', label: `Sous-titres ${c.language} (${c.fileName})`, ref: c.id, state: 'todo' });
  for (const p of d.playlistIds) steps.push({ id: uid(), kind: 'playlist', label: 'Ajout à la playlist', ref: p, state: 'todo' });
  if (d.ideaRowId) steps.push({ id: uid(), kind: 'kanban', label: 'Carte « Idées vidéo » → Publié', ref: d.ideaRowId, state: 'todo' });
  if (d.abTest && d.abTest.variants.length >= 2) steps.push({ id: uid(), kind: 'abtest', label: 'Test A/B planifié', state: 'todo' });
  return steps;
}

export async function enqueue(draft: VideoDraft, ctx: PublishContext): Promise<QueueItem> {
  await loadQueue();
  const item: QueueItem = {
    id: draft.id || uid(), draft: { ...draft, updatedAt: Date.now() }, description: ctx.description, channelTitle: ctx.channelTitle,
    state: 'attente', createdAt: Date.now(), confirmedAt: Date.now(), total: draft.file?.size ?? 0, offset: 0, attempts: 0,
    steps: initialSteps(draft), manual: {},
  };
  useQueue.setState(s => ({ items: [...s.items.filter(i => i.id !== item.id), item] }));
  persist(true);
  kickWorker();
  return item;
}

// ── Commandes de la file ─────────────────────────────────────
export async function pauseItem(id: string) {
  const it = getItem(id); if (!it) return;
  patch(id, { state: 'pause' });
  if (it.uploadUrl) await native.uploadCancel(it.uploadUrl).catch(() => undefined);
}
export function resumeItem(id: string) { patch(id, { state: 'attente', error: undefined }); kickWorker(); }
export async function removeItem(id: string) {
  const it = getItem(id); if (!it) return;
  if (it.state === 'envoi' && !(await confirmAction(`Annuler l'envoi de « ${it.draft.title} » ? La partie déjà envoyée sera perdue.`, { danger: true, confirmLabel: 'Annuler l’envoi' }))) return;
  if (it.uploadUrl && it.state === 'envoi') await native.uploadCancel(it.uploadUrl).catch(() => undefined);
  useQueue.setState(s => ({ items: s.items.filter(i => i.id !== id) }));
  persist(true);
}
export function reorderQueue(ids: string[]) {
  useQueue.setState(s => ({ items: ids.map(id => s.items.find(i => i.id === id)).filter((x): x is QueueItem => !!x).concat(s.items.filter(i => !ids.includes(i.id))) }));
  persist();
}
export function setManualCheck(id: string, key: string, value: boolean) { patch(id, it => ({ manual: { ...it.manual, [key]: value } })); }
export function clearFinished() { useQueue.setState(s => ({ items: s.items.filter(i => i.state !== 'termine') })); persist(true); }
export async function retrySteps(id: string) { const it = getItem(id); if (it?.videoId) { await finalize(id); } }

// ── Travailleur (une vidéo à la fois) ────────────────────────
let running = false;
export function kickWorker() { if (!running) void workerLoop(); }
async function workerLoop() {
  running = true;
  try {
    for (;;) {
      const next = useQueue.getState().items.find(i => i.state === 'attente');
      if (!next) break;
      useQueue.setState({ working: next.id });
      await processItem(next.id);
    }
  } finally { running = false; useQueue.setState({ working: null }); }
}

async function waitOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return;
  await new Promise<void>(res => { const on = () => { window.removeEventListener('online', on); res(); }; window.addEventListener('online', on); setTimeout(on, 60_000); });
}

async function processItem(id: string) {
  let it = getItem(id); if (!it) return;
  if (it.videoId) { await finalize(id); return; }
  if (!it.draft.file) { patch(id, { state: 'erreur', error: 'Aucun fichier vidéo.' }); return; }
  await bindProgress().catch(() => undefined);
  patch(id, { state: 'envoi', startedAt: it.startedAt ?? Date.now(), error: undefined });
  const path = it.draft.file.path;
  const tokens = new TokenCache(it.draft.channelId, [YOUTUBE_SCOPES.upload]);
  const meter = meters.get(id) ?? new SpeedMeter(); meters.set(id, meter); meter.reset();
  let retries = 0, unauthorized = 0, expired = 0;
  let needStatus = !!it.uploadUrl; // reprise : on demande d'abord ce que YouTube a reçu
  setLive(id, { phase: needStatus ? 'Reprise…' : 'Préparation…', sent: it.offset, bytesPerSec: 0, etaSec: null });

  const handle = async (st: UploadStep): Promise<'continue' | 'stop'> => {
    switch (st.status) {
      case 'incomplete':
        retries = 0; unauthorized = 0;
        patch(id, { offset: st.nextOffset, attempts: 0 });
        meter.add(st.nextOffset);
        setLive(id, { sent: st.nextOffset, bytesPerSec: meter.bytesPerSec(), etaSec: meter.eta((getItem(id)?.total ?? 0) - st.nextOffset), phase: 'Envoi' });
        return 'continue';
      case 'complete':
        patch(id, { videoId: st.videoId ?? undefined, offset: getItem(id)?.total ?? 0, uploadStatus: st.uploadStatus ?? undefined, state: st.message ? 'erreur' : 'finalisation', ...(st.message ? { error: st.message } : {}) });
        return 'stop';
      case 'retry': {
        retries++;
        if (retries > MAX_RETRIES) throw new Error(`${st.message ?? 'Connexion instable'} — envoi suspendu après ${MAX_RETRIES} tentatives (il reprendra là où il s'est arrêté).`);
        const delay = backoffDelay(retries - 1, Math.random, st.retryAfter);
        setLive(id, { phase: `${st.message ?? 'Coupure'} · nouvelle tentative dans ${Math.round(delay / 1000)} s`, bytesPerSec: 0, etaSec: null });
        patch(id, { attempts: retries });
        await sleep(delay); await waitOnline();
        needStatus = true; return 'continue';
      }
      case 'unauthorized':
        unauthorized++;
        if (unauthorized > 2) throw new Error('Jeton refusé par YouTube — reconnecte la chaîne dans Réglages → Connexions.');
        tokens.invalidate(); needStatus = true; return 'continue';
      case 'expired':
        expired++;
        if (expired > 2) throw new Error('La session d’envoi expire sans cesse — réessaie plus tard.');
        patch(id, { uploadUrl: undefined, sessionAt: undefined, offset: 0 });
        meter.reset(); needStatus = false; return 'continue';
      case 'cancelled':
      default:
        return 'stop';
    }
  };

  try {
    for (;;) {
      it = getItem(id);
      if (!it || it.state !== 'envoi') return; // mis en pause ou retiré
      if (!it.uploadUrl) {
        setLive(id, { phase: 'Ouverture de la session d’envoi…' });
        const resource = buildVideoResource(it.draft, it.description);
        const init = await native.uploadInit(path, resource, await tokens.get(), it.draft.notifySubscribers);
        void youtube.trackQuota('videos.insert').catch(() => undefined);
        patch(id, { uploadUrl: init.uploadUrl, sessionAt: Date.now(), total: init.total, offset: 0 });
        continue;
      }
      if (needStatus) {
        needStatus = false;
        setLive(id, { phase: 'Vérification de ce que YouTube a reçu…' });
        if ((await handle(await native.uploadStatus(it.uploadUrl, it.total, await tokens.get()))) === 'stop') break;
        continue;
      }
      if (it.offset >= it.total) { needStatus = true; continue; }
      const plan = planChunk(it.offset, it.total);
      const st = await native.uploadChunk(it.uploadUrl, path, plan.offset, plan.len, it.total, await tokens.get());
      if ((await handle(st)) === 'stop') break;
    }
  } catch (e) {
    patch(id, { state: 'erreur', error: errMsg(e) });
    setLive(id, { phase: undefined, bytesPerSec: 0, etaSec: null });
    toast(`Envoi de « ${it?.draft.title ?? ''} » interrompu : ${errMsg(e)}`, 'error');
    return;
  }
  if (getItem(id)?.state === 'finalisation') await finalize(id);
}

// ── Finalisation après l'envoi ───────────────────────────────
async function runStep(it: QueueItem, step: PostStep) {
  const d = it.draft; const videoId = it.videoId!;
  switch (step.kind) {
    case 'thumbnail': {
      if (!d.thumbnail) return;
      const prepared = await prepareThumbnail(d.thumbnail);
      await native.thumbnailSet(videoId, prepared.path, await youtube.token(d.channelId, [YOUTUBE_SCOPES.upload]));
      void youtube.trackQuota('thumbnails.set').catch(() => undefined);
      return;
    }
    case 'caption': {
      const c = d.captions.find(x => x.id === step.ref); if (!c) return;
      await native.captionInsert(videoId, c.path, c.language, c.name, c.isDraft, await youtube.token(d.channelId, [YOUTUBE_SCOPES.manage]));
      void youtube.trackQuota('captions.insert').catch(() => undefined);
      return;
    }
    case 'playlist': return addToPlaylist(d.channelId, step.ref!, videoId);
    case 'kanban': return markIdeaPublished(step.ref!, { url: videoUrl(videoId), videoId, date: d.scheduleAt ? new Date(d.scheduleAt) : new Date(), channelTitle: it.channelTitle });
    case 'abtest': {
      if (!d.abTest) return;
      await createPlannedAbTest({ channelId: d.channelId, channelTitle: it.channelTitle, videoId, videoTitle: d.title, plan: d.abTest, startAt: d.scheduleAt ? Date.parse(d.scheduleAt) : effectivePrivacy(d) === 'public' ? Date.now() : undefined, originalThumbnail: d.thumbnail });
      return;
    }
  }
}

async function finalize(id: string) {
  let it = getItem(id); if (!it?.videoId) return;
  patch(id, { state: 'finalisation' });
  setLive(id, { phase: 'Finalisation (miniature, sous-titres, playlists…)', bytesPerSec: 0, etaSec: null });
  for (const step of it.steps) {
    if (step.state === 'ok') continue;
    try { await runStep(it, step); patch(id, i => ({ steps: i.steps.map(s => (s.id === step.id ? { ...s, state: 'ok', error: undefined } : s)) })); }
    catch (e) { patch(id, i => ({ steps: i.steps.map(s => (s.id === step.id ? { ...s, state: 'error', error: errMsg(e), attempts: (s.attempts ?? 0) + 1 } : s)) })); }
  }
  it = getItem(id)!;
  const d = it.draft;
  await recordPublished({
    videoId: it.videoId!, channelId: d.channelId, channelTitle: it.channelTitle, title: d.title, privacy: effectivePrivacy(d), scheduleAt: d.scheduleAt,
    publishedAt: d.scheduleAt ? Date.parse(d.scheduleAt) : Date.now(), url: videoUrl(it.videoId!), ideaRowId: d.ideaRowId, thumbnailHash: d.thumbnail?.hash, thumbnailPath: d.thumbnail?.path,
  });
  const failed = it.steps.filter(s => s.state === 'error');
  patch(id, { state: 'termine', finishedAt: Date.now() });
  setLive(id, { phase: undefined });
  if (failed.length) {
    toast(`« ${d.title} » est en ligne, mais ${failed.length} étape(s) ont échoué (${failed.map(s => s.label).join(', ')}). Nouvel essai dans 3 min.`, 'warning');
    // Miniature d'un Short : YouTube exige la fin du traitement → nouvelles tentatives espacées.
    if (failed.some(s => (s.attempts ?? 0) < 4)) setTimeout(() => { void retrySteps(id); }, 3 * 60_000);
  } else toast(d.scheduleAt ? `« ${d.title} » est programmée.` : `« ${d.title} » est en ligne.`, 'success');
}
