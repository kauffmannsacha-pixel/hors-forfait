// Instantanés horaires des vues. L'API YouTube ne fournit PAS de vues par heure (Analytics : jour minimum) :
// tant que Prisme est ouvert, il relève lui-même le compteur public (videos.list, 1 unité de quota par lot de 50)
// des vidéos publiées depuis moins de 72 h, environ une fois par heure. Stockage : kv.
import { youtube, type YtVideo } from '../../../connectors/api';
import { repo } from '../../../db/store';
import type { Snapshot } from '../lib/series';

export const TRACK_HOURS = 72;
const MIN_GAP = 55 * 60_000;      // un instantané par heure environ
const TICK = 5 * 60_000;          // vérification toutes les 5 min
const DISCOVERY_EVERY = 60 * 60_000;
const INDEX_KEY = 'stats.snap.index';
const SNAP_KEY = (id: string) => `stats.snap.v.${id}`;
const UPLOADS_KEY = (ch: string) => `stats.snap.uploads.${ch}`;
const MAX_POINTS = 600;
const MAX_TRACKED = 300;

export interface TrackedVideo {
  videoId: string; channelId: string; channelTitle: string; title: string; publishedAt: string;
  mine: boolean; addedAt: number; lastSnap?: number; count?: number;
}
interface SchedulerState { running: boolean; lastTick: number | null; lastDiscovery: number; lastError: string | null; ticking: boolean }
const state: SchedulerState = { running: false, lastTick: null, lastDiscovery: 0, lastError: null, ticking: false };
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
/** Abonnement aux changements (nouvel instantané, erreur…) pour rafraîchir l'UI. */
export const onSnapshotsChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const ageH = (publishedAt: string, now = Date.now()) => (now - new Date(publishedAt).getTime()) / 3_600_000;
export const isTrackable = (v: Pick<YtVideo, 'publishedAt'>, now = Date.now()) => { const a = ageH(v.publishedAt, now); return a >= 0 && a < TRACK_HOURS; };

export async function listTracked(): Promise<TrackedVideo[]> {
  return (await repo.kvGet<TrackedVideo[]>(INDEX_KEY).catch(() => undefined)) ?? [];
}
async function saveIndex(list: TrackedVideo[]) {
  const sorted = list.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()).slice(0, MAX_TRACKED);
  await repo.kvSet(INDEX_KEY, sorted);
}
export async function getSnapshots(videoId: string): Promise<Snapshot[]> {
  return (await repo.kvGet<Snapshot[]>(SNAP_KEY(videoId)).catch(() => undefined)) ?? [];
}
async function appendSnapshot(videoId: string, s: Snapshot, force: boolean): Promise<boolean> {
  const list = await getSnapshots(videoId);
  const last = list[list.length - 1];
  if (last && !force && s.t - last.t < MIN_GAP) return false;
  if (last && s.t - last.t < 60_000) return false; // doublon
  list.push(s);
  await repo.kvSet(SNAP_KEY(videoId), list.slice(-MAX_POINTS));
  return true;
}

/** Ajoute une vidéo au suivi horaire (seulement si publiée depuis moins de 72 h) et prend un premier instantané. */
export async function trackVideo(v: YtVideo, mine: boolean): Promise<boolean> {
  if (!isTrackable(v)) return false;
  const list = await listTracked();
  if (!list.some(t => t.videoId === v.id)) {
    list.push({ videoId: v.id, channelId: v.channelId, channelTitle: v.channelTitle, title: v.title, publishedAt: v.publishedAt, mine, addedAt: Date.now() });
    await saveIndex(list);
  }
  const snaps = await getSnapshots(v.id);
  const last = snaps[snaps.length - 1];
  if (!last || Date.now() - last.t >= MIN_GAP) await recordFromVideos([v], false);
  emit();
  return true;
}

async function recordFromVideos(videos: YtVideo[], force: boolean): Promise<number> {
  const now = Date.now();
  const list = await listTracked();
  let n = 0;
  for (const v of videos) {
    if (!Number.isFinite(v.views)) continue;
    const added = await appendSnapshot(v.id, { t: now, views: v.views, likes: v.likes, comments: v.comments }, force);
    if (!added) continue;
    n++;
    const t = list.find(x => x.videoId === v.id);
    if (t) { t.lastSnap = now; t.count = (t.count ?? 0) + 1; t.title = v.title; }
  }
  if (n) await saveIndex(list);
  return n;
}

/** Instantané immédiat des vidéos suivies (ou de celles indiquées). Renvoie le nombre d'instantanés pris. */
export async function snapshotNow(videoIds?: string[], force = false): Promise<number> {
  const list = await listTracked();
  const now = Date.now();
  const due = (videoIds ?? list.filter(t => isTrackable(t, now) && (force || !t.lastSnap || now - t.lastSnap >= MIN_GAP)).map(t => t.videoId));
  if (!due.length) return 0;
  let n = 0;
  for (let i = 0; i < due.length; i += 50) {
    const videos = await youtube.videos(due.slice(i, i + 50));
    n += await recordFromVideos(videos, force);
  }
  if (n) emit();
  return n;
}

/** Découverte des nouvelles vidéos de mes chaînes via la playlist « uploads » (playlistItems.list : 1 unité). */
async function discover(): Promise<void> {
  const channels = await youtube.channels().catch(() => []);
  for (const ch of channels) {
    let uploads = await repo.kvGet<string>(UPLOADS_KEY(ch.id)).catch(() => undefined);
    let ids: string[] = [];
    try {
      if (!uploads) {
        const res = await youtube.data<{ items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>('channels', { part: 'contentDetails', id: ch.id }, { channelId: ch.id });
        uploads = res.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (uploads) await repo.kvSet(UPLOADS_KEY(ch.id), uploads);
      }
      if (uploads) {
        const res = await youtube.data<{ items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[] }>('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 10 }, { channelId: ch.id });
        ids = (res.items ?? [])
          .filter(it => it.contentDetails?.videoId && (!it.contentDetails.videoPublishedAt || isTrackable({ publishedAt: it.contentDetails.videoPublishedAt })))
          .map(it => it.contentDetails!.videoId!);
      }
    } catch {
      // Repli : liste des vidéos du connecteur (peut coûter plus de quota) — seulement toutes les 6 h.
      if (Date.now() - state.lastDiscovery < 6 * DISCOVERY_EVERY && state.lastDiscovery !== 0) continue;
      const vids = await youtube.channelVideos(ch.id, { max: 5, order: 'date' }).catch(() => [] as YtVideo[]);
      for (const v of vids) if (isTrackable(v)) await trackVideo(v, true);
      continue;
    }
    if (!ids.length) continue;
    const known = new Set((await listTracked()).map(t => t.videoId));
    const fresh = ids.filter(id => !known.has(id));
    if (!fresh.length) continue;
    const vids = await youtube.videos(fresh);
    for (const v of vids) if (isTrackable(v)) await trackVideo(v, true);
  }
}

async function tick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const channels = await youtube.channels().catch(() => []);
    const tracked = await listTracked();
    if (!channels.length && !tracked.some(t => isTrackable(t))) return; // rien à suivre
    if (channels.length && Date.now() - state.lastDiscovery >= DISCOVERY_EVERY) {
      await discover();
      state.lastDiscovery = Date.now();
    }
    await snapshotNow();
    state.lastError = null;
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    state.lastTick = Date.now();
    state.ticking = false;
    emit();
  }
}

/** Démarre le planificateur (une seule fois, même si le module est rechargé). Renvoie la fonction d'arrêt. */
export function startSnapshotScheduler(): () => void {
  if (state.running || typeof window === 'undefined') return stopSnapshotScheduler;
  state.running = true;
  firstRun = setTimeout(() => { void tick(); }, 20_000); // laisse l'app démarrer
  timer = setInterval(() => { void tick(); }, TICK);
  return stopSnapshotScheduler;
}
export function stopSnapshotScheduler() {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = null; firstRun = null; state.running = false;
}
export function schedulerInfo() {
  return { running: state.running, lastTick: state.lastTick, nextTick: state.lastTick ? state.lastTick + TICK : null, lastError: state.lastError, intervalMin: MIN_GAP / 60_000 };
}
