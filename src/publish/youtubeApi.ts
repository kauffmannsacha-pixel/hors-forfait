// Appels YouTube du module Publication : Data API v3 (via le connecteur), Analytics v2, Reporting API (portée/CTR).
import { YOUTUBE_SCOPES, youtube, type AnalyticsResult } from '../connectors/api';
import { httpError, httpFetch } from '../db/http';
import { repo } from '../db/store';
import { mergeReach, normDate, parseReachCsv } from './reach';
import { addDays, ptDate, ptMidnight } from './tz';
import type { AbDaily } from './types';

export interface Category { id: string; title: string }
export interface Language { id: string; name: string }
export interface Playlist { id: string; title: string; count: number; privacy?: string; thumbnail?: string }

const DAY = 86_400_000;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Référentiels ─────────────────────────────────────────────
export const FALLBACK_CATEGORIES: Category[] = [
  { id: '1', title: 'Films et animations' }, { id: '2', title: 'Auto et véhicules' }, { id: '10', title: 'Musique' },
  { id: '15', title: 'Animaux' }, { id: '17', title: 'Sport' }, { id: '19', title: 'Voyages et événements' },
  { id: '20', title: 'Jeux vidéo' }, { id: '22', title: 'Vlog et personnes' }, { id: '23', title: 'Humour' },
  { id: '24', title: 'Divertissement' }, { id: '25', title: 'Actualités et politique' }, { id: '26', title: 'Vie pratique et style' },
  { id: '27', title: 'Éducation' }, { id: '28', title: 'Science et technologie' }, { id: '29', title: 'Associations et activisme' },
];
export const FALLBACK_LANGUAGES: Language[] = [
  { id: 'fr', name: 'Français' }, { id: 'fr-CA', name: 'Français (Canada)' }, { id: 'en', name: 'Anglais' }, { id: 'en-US', name: 'Anglais (États-Unis)' },
  { id: 'en-GB', name: 'Anglais (Royaume-Uni)' }, { id: 'es', name: 'Espagnol' }, { id: 'de', name: 'Allemand' }, { id: 'it', name: 'Italien' },
  { id: 'pt', name: 'Portugais' }, { id: 'pt-BR', name: 'Portugais (Brésil)' }, { id: 'nl', name: 'Néerlandais' }, { id: 'ar', name: 'Arabe' },
  { id: 'ja', name: 'Japonais' }, { id: 'ko', name: 'Coréen' }, { id: 'zh-Hans', name: 'Chinois (simplifié)' }, { id: 'ru', name: 'Russe' },
  { id: 'pl', name: 'Polonais' }, { id: 'tr', name: 'Turc' }, { id: 'zxx', name: 'Sans paroles' },
];

/** videoCategories.list (catégories attribuables), mise en cache 30 jours. */
export async function listCategories(channelId?: string, regionCode = 'FR'): Promise<Category[]> {
  const key = `publish:categories:${regionCode}`;
  const cached = await repo.kvGet<{ at: number; items: Category[] }>(key);
  if (cached?.items?.length && Date.now() - cached.at < 30 * DAY) return cached.items;
  try {
    const r = await youtube.data<{ items?: { id: string; snippet?: { title?: string; assignable?: boolean } }[] }>('videoCategories', { part: 'snippet', regionCode, hl: 'fr' }, { channelId, cacheTtlSec: 30 * 86400 });
    const items = (r.items ?? []).filter(i => i.snippet?.assignable !== false).map(i => ({ id: i.id, title: i.snippet?.title ?? i.id }));
    if (items.length) { await repo.kvSet(key, { at: Date.now(), items }); return items; }
  } catch { /* repli hors-ligne */ }
  return cached?.items?.length ? cached.items : FALLBACK_CATEGORIES;
}

/** i18nLanguages.list (noms en français), mise en cache 30 jours. */
export async function listLanguages(channelId?: string): Promise<Language[]> {
  const key = 'publish:languages:fr';
  const cached = await repo.kvGet<{ at: number; items: Language[] }>(key);
  if (cached?.items?.length && Date.now() - cached.at < 30 * DAY) return cached.items;
  try {
    const r = await youtube.data<{ items?: { id: string; snippet?: { hl?: string; name?: string } }[] }>('i18nLanguages', { part: 'snippet', hl: 'fr' }, { channelId, cacheTtlSec: 30 * 86400 });
    const items = (r.items ?? []).map(i => ({ id: i.snippet?.hl ?? i.id, name: i.snippet?.name ?? i.id }));
    const first = ['fr', 'en'];
    items.sort((a, b) => (first.indexOf(b.id) - first.indexOf(a.id)) || a.name.localeCompare(b.name, 'fr'));
    if (items.length) { await repo.kvSet(key, { at: Date.now(), items }); return items; }
  } catch { /* repli */ }
  return cached?.items?.length ? cached.items : FALLBACK_LANGUAGES;
}

/** playlists.list de la chaîne (mine=true avec le jeton de la chaîne). */
export async function listPlaylists(channelId: string, fresh = false): Promise<Playlist[]> {
  const out: Playlist[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 6; i++) {
    const r = await youtube.data<{ nextPageToken?: string; items?: { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> }; contentDetails?: { itemCount?: number }; status?: { privacyStatus?: string } }[] }>(
      'playlists', { part: 'snippet,contentDetails,status', mine: true, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, { channelId, cacheTtlSec: 600, fresh });
    for (const p of r.items ?? []) out.push({ id: p.id, title: p.snippet?.title ?? p.id, count: p.contentDetails?.itemCount ?? 0, privacy: p.status?.privacyStatus, thumbnail: p.snippet?.thumbnails?.medium?.url ?? p.snippet?.thumbnails?.default?.url });
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// ── Vidéos ───────────────────────────────────────────────────
export interface VideoSnippet { title: string; description: string; tags?: string[]; categoryId: string; defaultLanguage?: string; defaultAudioLanguage?: string; thumbnails?: Record<string, { url?: string; width?: number; height?: number }> }
export interface VideoState { snippet: VideoSnippet; privacyStatus?: string; publishAt?: string; uploadStatus?: string; processingStatus?: string }

export async function getVideoState(channelId: string, videoId: string): Promise<VideoState | null> {
  const r = await youtube.data<{ items?: { snippet: VideoSnippet; status?: { privacyStatus?: string; publishAt?: string; uploadStatus?: string }; processingDetails?: { processingStatus?: string } }[] }>(
    'videos', { part: 'snippet,status,processingDetails', id: videoId }, { channelId, cacheTtlSec: 0, fresh: true });
  const v = r.items?.[0];
  return v ? { snippet: v.snippet, privacyStatus: v.status?.privacyStatus, publishAt: v.status?.publishAt, uploadStatus: v.status?.uploadStatus, processingStatus: v.processingDetails?.processingStatus } : null;
}

/** videos.update (part=snippet) : remplace le titre en conservant description, tags, catégorie et langues. */
export async function updateVideoTitle(channelId: string, videoId: string, title: string): Promise<void> {
  await youtube.token(channelId, [YOUTUBE_SCOPES.manage]);
  const cur = await getVideoState(channelId, videoId);
  if (!cur) throw new Error('Vidéo introuvable sur YouTube (supprimée ?).');
  const s = cur.snippet;
  const snippet: Record<string, unknown> = { title: title.slice(0, 100), description: s.description ?? '', categoryId: s.categoryId };
  if (s.tags?.length) snippet.tags = s.tags;
  if (s.defaultLanguage) snippet.defaultLanguage = s.defaultLanguage;
  if (s.defaultAudioLanguage) snippet.defaultAudioLanguage = s.defaultAudioLanguage;
  await youtube.data('videos', { part: 'snippet' }, { channelId, method: 'PUT', body: { id: videoId, snippet } });
}

/** playlistItems.insert */
export async function addToPlaylist(channelId: string, playlistId: string, videoId: string): Promise<void> {
  await youtube.token(channelId, [YOUTUBE_SCOPES.manage]);
  await youtube.data('playlistItems', { part: 'snippet' }, { channelId, method: 'POST', body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } } });
}

// ── Analytics ────────────────────────────────────────────────
const col = (r: AnalyticsResult, name: string, fallback: number) => { const i = r.columns.findIndex(c => c === name || c.endsWith('.' + name)); return i >= 0 ? i : fallback; };

/** Vues + durée moyenne par jour (PT) d'une vidéo. */
export async function dailyVideoMetrics(channelId: string, videoId: string, startDate: string, endDate: string): Promise<AbDaily[]> {
  const r = await youtube.analytics({ channelId, metrics: ['views', 'averageViewDuration', 'estimatedMinutesWatched'], dimensions: ['day'], filters: `video==${videoId}`, startDate, endDate, sort: 'day' });
  const iDay = col(r, 'day', 0), iViews = col(r, 'views', 1), iAvd = col(r, 'averageViewDuration', 2);
  return r.rows.map(row => ({ date: normDate(String(row[iDay])), views: Number(row[iViews]) || 0, avgViewDuration: Number(row[iAvd]) || 0 }));
}

/** Totaux d'une vidéo sur une période (vues, durée moyenne, % moyen regardé). */
export async function videoTotals(channelId: string, videoId: string, startDate: string, endDate: string): Promise<{ views: number; avgViewDuration: number; avgViewPercentage?: number } | null> {
  const r = await youtube.analytics({ channelId, metrics: ['views', 'averageViewDuration', 'averageViewPercentage'], filters: `video==${videoId}`, startDate, endDate });
  const row = r.rows[0];
  if (!row) return null;
  return { views: Number(row[col(r, 'views', 0)]) || 0, avgViewDuration: Number(row[col(r, 'averageViewDuration', 1)]) || 0, avgViewPercentage: Number(row[col(r, 'averageViewPercentage', 2)]) || undefined };
}

// ── Reporting API : impressions et CTR des miniatures ────────
const REPORTING = 'https://youtubereporting.googleapis.com/v1';
interface ReportInfo { id: string; startTime: string; createTime?: string; downloadUrl: string }
interface ReachCache { jobId?: string; reportTypeId?: string; createdAt?: number; downloaded: Record<string, string[]>; data: Record<string, Record<string, { impressions: number; ctr: number; created: string }>> }

async function reporting<T>(channelId: string, url: string, init: RequestInit = {}, raw = false): Promise<T> {
  const token = await youtube.token(channelId, [YOUTUBE_SCOPES.analytics]);
  const r = await httpFetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!r.ok) throw await httpError('YouTube Reporting API', r);
  return (raw ? r.text() : r.json()) as Promise<T>;
}

/** Crée (une fois) la tâche de rapport « Portée » de la chaîne. Renvoie null si le type de rapport n'existe pas. */
export async function ensureReachJob(channelId: string): Promise<{ jobId: string; createdAt: number } | null> {
  const key = `publish:reach:${channelId}`;
  const cache = (await repo.kvGet<ReachCache>(key)) ?? { downloaded: {}, data: {} };
  if (cache.jobId) return { jobId: cache.jobId, createdAt: cache.createdAt ?? Date.now() };
  const types: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r: { reportTypes?: { id: string; deprecateTime?: string }[]; nextPageToken?: string } = await reporting(channelId, `${REPORTING}/reportTypes${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`);
    for (const t of r.reportTypes ?? []) if (/^channel_reach_basic_a\d+$/.test(t.id) && !t.deprecateTime) types.push(t.id);
    token = r.nextPageToken; if (!token) break;
  }
  const type = types.sort().pop();
  if (!type) return null;
  const jobs: { id: string; reportTypeId: string; createTime?: string }[] = [];
  token = undefined;
  for (let i = 0; i < 5; i++) {
    const r: { jobs?: { id: string; reportTypeId: string; createTime?: string }[]; nextPageToken?: string } = await reporting(channelId, `${REPORTING}/jobs${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`);
    jobs.push(...(r.jobs ?? []));
    token = r.nextPageToken; if (!token) break;
  }
  let job = jobs.find(j => j.reportTypeId === type);
  if (!job) job = await reporting<{ id: string; reportTypeId: string; createTime?: string }>(channelId, `${REPORTING}/jobs`, { method: 'POST', body: JSON.stringify({ reportTypeId: type, name: 'Prisme — portée des vidéos (tests A/B)' }) });
  const createdAt = job.createTime ? Date.parse(job.createTime) : Date.now();
  await repo.kvSet(key, { ...cache, jobId: job.id, reportTypeId: type, createdAt });
  return { jobId: job.id, createdAt };
}

/**
 * Impressions + CTR par jour (PT) pour des vidéos, depuis `fromDate`.
 * Les rapports déjà téléchargés sont mis en cache ; un rapport de rattrapage (backfill) plus récent remplace l'ancien.
 */
export async function fetchReach(channelId: string, videoIds: string[], fromDate: string): Promise<Map<string, { impressions: number; ctr: number }>> {
  const job = await ensureReachJob(channelId);
  const out = new Map<string, { impressions: number; ctr: number }>();
  if (!job) return out;
  const key = `publish:reach:${channelId}`;
  const cache = (await repo.kvGet<ReachCache>(key)) ?? { downloaded: {}, data: {} };
  cache.downloaded ??= {}; cache.data ??= {};
  const reports: ReportInfo[] = [];
  let token: string | undefined;
  const after = new Date(ptMidnight(addDays(fromDate, -1))).toISOString();
  for (let i = 0; i < 10; i++) {
    const r: { reports?: ReportInfo[]; nextPageToken?: string } = await reporting(channelId, `${REPORTING}/jobs/${encodeURIComponent(job.jobId)}/reports?startTimeAtOrAfter=${encodeURIComponent(after)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
    reports.push(...(r.reports ?? []));
    token = r.nextPageToken; if (!token) break;
  }
  const wanted = new Set(videoIds);
  for (const rep of reports.sort((a, b) => (a.createTime ?? '').localeCompare(b.createTime ?? ''))) {
    const done = cache.downloaded[rep.id] ?? [];
    if (videoIds.every(v => done.includes(v))) continue;
    try {
      const csv = await reporting<string>(channelId, rep.downloadUrl, {}, true);
      const date = ptDate(Date.parse(rep.startTime) + 12 * 3_600_000);
      const merged = mergeReach(parseReachCsv(csv, wanted));
      for (const v of videoIds) {
        const m = merged.get(`${v}|${date}`) ?? [...merged.entries()].find(([k]) => k.startsWith(v + '|'))?.[1];
        const prev = cache.data[v]?.[date];
        if (prev && (prev.created ?? '') > (rep.createTime ?? '')) continue;
        (cache.data[v] ??= {})[date] = { impressions: m?.impressions ?? 0, ctr: m?.ctr ?? 0, created: rep.createTime ?? '' };
      }
      cache.downloaded[rep.id] = [...new Set([...done, ...videoIds])];
    } catch (e) { console.warn('Rapport de portée illisible', rep.id, errMsg(e)); }
  }
  await repo.kvSet(key, cache);
  for (const v of videoIds) for (const [date, m] of Object.entries(cache.data[v] ?? {})) if (date >= fromDate) out.set(`${v}|${date}`, { impressions: m.impressions, ctr: m.ctr });
  return out;
}
