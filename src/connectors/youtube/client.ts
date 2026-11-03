// Client YouTube Data API v3 + YouTube Analytics API v2 : cache TTL, file d'attente, quota, erreurs lisibles.
import { httpFetch } from '../../db/http';
import { secrets } from '../../db/secrets';
import { parseISODuration, type AnalyticsQuery, type AnalyticsResult, type YtVideo } from '../api';
import { sharedCache, stableKey } from '../core/cache';
import { ConnectorError, networkError, withRetry } from '../core/errors';
import { methodKey } from '../core/quota';
import { chunk, RequestQueue, uniq } from '../core/queue';
import { bestThumb, channelToken, listChannels, YT_API, ytTokens, type RawChannel } from './channels';
import { markExhausted, quotaCheck, quotaExceededMessage, quotaRecord } from './quotaStore';

const ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
const API_KEY = 'youtube.api_key';
const queue = new RequestQueue(4, 60);

let apiKey: string | null | undefined;
export async function getApiKey(): Promise<string | null> {
  if (apiKey === undefined) apiKey = (await secrets.get(API_KEY)) || null;
  return apiKey;
}
export async function setApiKey(k: string | null) {
  if (k) await secrets.set(API_KEY, k.trim()); else await secrets.del(API_KEY);
  apiKey = k ? k.trim() : null;
}

/** Durée de vie du cache par méthode (secondes). */
export function defaultTtlSec(key: string): number {
  switch (key) {
    case 'search.list': return 12 * 3600;            // bucket de 100 appels / jour : on économise
    case 'videos.list': return 30 * 60;
    case 'channels.list': return 60 * 60;
    case 'playlistItems.list': return 20 * 60;
    case 'playlists.list': return 60 * 60;
    case 'commentThreads.list': case 'comments.list': return 15 * 60;
    case 'videoCategories.list': case 'i18nLanguages.list': case 'i18nRegions.list': case 'guideCategories.list': return 7 * 86_400;
    case 'captions.list': return 6 * 3600;
    default: return 15 * 60;
  }
}

interface YtErr { error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] } }

async function ytError(r: Response, key: string): Promise<ConnectorError> {
  let j: YtErr = {};
  try { j = await r.json(); } catch { /* non JSON */ }
  const reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? '';
  const msg = j.error?.message?.replace(/<[^>]+>/g, '') ?? '';
  const info = { service: 'YouTube', status: r.status, code: reason };
  switch (reason) {
    case 'quotaExceeded': case 'dailyLimitExceeded': case 'RESOURCE_EXHAUSTED':
      await markExhausted(key);
      return new ConnectorError(quotaExceededMessage(key), info);
    case 'rateLimitExceeded': case 'userRateLimitExceeded': case 'RATE_LIMIT_EXCEEDED':
      return new ConnectorError('YouTube : trop de requêtes rapprochées, nouvel essai…', { ...info, retryable: true, retryAfterMs: 2500 });
    case 'keyInvalid': case 'API_KEY_INVALID': case 'badRequest':
      if (/API key/i.test(msg) || reason !== 'badRequest') return new ConnectorError('Clé API YouTube invalide — vérifie-la dans Réglages → Connexions → YouTube.', info);
      break;
    case 'accessNotConfigured': case 'SERVICE_DISABLED':
      return new ConnectorError('L’API YouTube n’est pas activée dans ton projet Google Cloud (API et services → Bibliothèque : « YouTube Data API v3 » et « YouTube Analytics API »).', info);
    case 'insufficientPermissions': case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
      return new ConnectorError('Autorisation YouTube insuffisante — reconnecte la chaîne en acceptant toutes les cases.', { ...info, needsReauth: true });
    case 'forbidden': case 'PERMISSION_DENIED':
      return new ConnectorError(`YouTube : accès refusé${msg ? ` (${msg})` : ''}.`, info);
    case 'videoNotFound': case 'channelNotFound': case 'playlistNotFound': case 'notFound':
      return new ConnectorError('YouTube : vidéo, chaîne ou playlist introuvable (privée ou supprimée ?).', { ...info, code: 'notFound' });
    case 'uploadLimitExceeded':
      return new ConnectorError('YouTube : limite de mises en ligne atteinte pour cette chaîne aujourd’hui.', info);
  }
  if (r.status === 401) return new ConnectorError('YouTube : session expirée — reconnecte la chaîne.', { ...info, needsReauth: true });
  if (r.status >= 500) return new ConnectorError(`YouTube indisponible (erreur ${r.status}), nouvel essai…`, { ...info, retryable: true });
  return new ConnectorError(`YouTube : ${msg || 'erreur ' + r.status}`, info);
}

type Params = Record<string, string | number | boolean>;
export interface DataOpts { channelId?: string; method?: string; body?: unknown; cacheTtlSec?: number; fresh?: boolean }

async function send<T>(path: string, params: Params, method: string, opts: DataOpts, key: string): Promise<T> {
  await quotaCheck(key);
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  const headers: Record<string, string> = { Accept: 'application/json' };
  let owner: string | undefined;
  if (opts.channelId) { headers.Authorization = `Bearer ${await channelToken(opts.channelId)}`; owner = opts.channelId; }
  else {
    const k = await getApiKey();
    if (k) qs.set('key', k);
    else {
      const first = (await listChannels()).find(c => !c.needsReauth);
      if (!first) throw new ConnectorError('YouTube n’est pas configuré : ajoute une clé API ou connecte une chaîne (Réglages → Connexions → YouTube).');
      headers.Authorization = `Bearer ${await channelToken(first.id)}`; owner = first.id;
    }
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const url = `${YT_API}${path}${qs.toString() ? `?${qs}` : ''}`;
  let r: Response;
  try { r = await httpFetch(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }); }
  catch (e) { throw networkError('YouTube', e); }
  await quotaRecord(key);
  if (r.status === 401 && owner) { ytTokens.invalidate(owner); throw new ConnectorError('YouTube : jeton expiré, nouvel essai…', { retryable: true, retryAfterMs: 50 }); }
  if (!r.ok) throw await ytError(r, key);
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Appel brut à l'API Data v3 (GET mis en cache, mode hors-ligne : dernière valeur connue). */
export async function ytData<T = unknown>(path: string, params: Params = {}, opts: DataOpts = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const clean = path.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/^youtube\/v3\//, '');
  const key = methodKey(clean, method);
  const exec = () => queue.run(() => withRetry(() => send<T>(clean, params, method, opts, key), { retries: 2 }));
  if (method !== 'GET' || opts.cacheTtlSec === 0) return exec();
  const ttl = (opts.cacheTtlSec ?? defaultTtlSec(key)) * 1000;
  const ck = `yt:${opts.channelId ?? '_'}:${clean}?${stableKey(params)}`;
  return (await sharedCache().wrap<T>(ck, ttl, exec, { force: opts.fresh })).value;
}

// ── Vidéos ───────────────────────────────────────────────────
interface RawVideo {
  id: string;
  snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }>; channelId?: string; channelTitle?: string; tags?: string[]; categoryId?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}
export function mapVideo(v: RawVideo): YtVideo {
  const s = v.snippet ?? {};
  return {
    id: v.id, title: s.title ?? '', description: s.description ?? '', publishedAt: s.publishedAt ?? '', thumbnail: bestThumb(s.thumbnails) || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    channelId: s.channelId ?? '', channelTitle: s.channelTitle ?? '', durationSec: parseISODuration(v.contentDetails?.duration ?? 'PT0S'),
    views: Number(v.statistics?.viewCount ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0),
    tags: s.tags, categoryId: s.categoryId,
  };
}

async function fetchVideos(ids: string[], channelId?: string): Promise<YtVideo[]> {
  const unique = uniq(ids.filter(Boolean));
  const parts = await Promise.all(chunk(unique, 50).map(c =>
    ytData<{ items?: RawVideo[] }>('videos', { part: 'snippet,contentDetails,statistics', id: c.join(','), maxResults: 50 }, { channelId })));
  const byId = new Map(parts.flatMap(p => p.items ?? []).map(v => [v.id, mapVideo(v)]));
  return unique.map(id => byId.get(id)).filter((v): v is YtVideo => !!v);
}

/** Infos publiques de vidéos (par paquets de 50 : 1 unité par paquet). */
export const videos = (ids: string[]) => fetchVideos(ids);

/** Playlist « uploads » d'une chaîne (cache 7 jours). */
async function uploadsPlaylist(channelId: string): Promise<string> {
  const mine = (await listChannels()).find(c => c.id === channelId);
  if (mine?.uploadsPlaylistId) return mine.uploadsPlaylistId;
  const j = await ytData<{ items?: RawChannel[] }>('channels', { part: 'contentDetails', id: channelId }, { cacheTtlSec: 7 * 86_400 });
  const id = j.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!id) throw new ConnectorError('YouTube : chaîne introuvable.', { code: 'notFound' });
  return id;
}

/** Vidéos d'une chaîne via sa playlist « uploads » (1 unité / 50 vidéos, bien moins cher que search.list). */
export async function channelVideos(channelId: string, opts: { max?: number; order?: 'date' | 'viewCount' } = {}): Promise<YtVideo[]> {
  const max = Math.max(1, Math.min(opts.max ?? 50, 500));
  const order = opts.order ?? 'date';
  const scan = order === 'viewCount' ? Math.min(500, Math.max(max * 4, 200)) : max;
  const owner = (await listChannels()).find(c => c.id === channelId && !c.needsReauth)?.id; // propriétaire : vidéos privées / programmées incluses
  const playlistId = await uploadsPlaylist(channelId);
  const ids: string[] = []; let pageToken = '';
  try {
    do {
      const j = await ytData<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>(
        'playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, { channelId: owner });
      for (const it of j.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      pageToken = j.nextPageToken ?? '';
    } while (pageToken && ids.length < scan);
  } catch (e) {
    if (e instanceof ConnectorError && e.info.code === 'notFound') return []; // chaîne sans vidéo
    throw e;
  }
  const list = await fetchVideos(ids.slice(0, scan), owner);
  list.sort(order === 'viewCount' ? (a, b) => b.views - a.views : (a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return list.slice(0, max);
}

/** Recherche (search.list : bucket dédié de 100 appels / jour — résultats mis en cache 12 h). */
export async function search(q: string, opts: { max?: number; order?: 'relevance' | 'viewCount' | 'date'; type?: 'video' | 'channel'; channelId?: string; regionCode?: string; relevanceLanguage?: string } = {}): Promise<YtVideo[]> {
  const max = Math.max(1, Math.min(opts.max ?? 25, 200));
  const type = opts.type ?? 'video';
  const ids: string[] = []; let pageToken = '';
  do {
    const j = await ytData<{ items?: { id?: { videoId?: string; channelId?: string } }[]; nextPageToken?: string }>('search', {
      part: 'snippet', q, type, maxResults: Math.min(50, max - ids.length), order: opts.order ?? 'relevance',
      ...(opts.channelId ? { channelId: opts.channelId } : {}), ...(opts.regionCode ? { regionCode: opts.regionCode } : {}),
      ...(opts.relevanceLanguage ? { relevanceLanguage: opts.relevanceLanguage } : {}), ...(pageToken ? { pageToken } : {}),
    });
    for (const it of j.items ?? []) { const id = type === 'channel' ? it.id?.channelId : it.id?.videoId; if (id) ids.push(id); }
    pageToken = j.nextPageToken ?? '';
  } while (pageToken && ids.length < max);
  if (type === 'video') return fetchVideos(ids.slice(0, max));
  // Chaînes : on renvoie des YtVideo « chaîne » (vues totales, abonnés dans likes = non ; voir contrat).
  const out: YtVideo[] = [];
  for (const c of chunk(uniq(ids).slice(0, max), 50)) {
    const j = await ytData<{ items?: (RawChannel & { snippet?: { description?: string; publishedAt?: string } })[] }>('channels', { part: 'snippet,statistics', id: c.join(','), maxResults: 50 });
    for (const ch of j.items ?? []) {
      out.push({
        id: ch.id, title: ch.snippet?.title ?? '', description: ch.snippet?.description ?? '', publishedAt: ch.snippet?.publishedAt ?? '', thumbnail: bestThumb(ch.snippet?.thumbnails),
        channelId: ch.id, channelTitle: ch.snippet?.title ?? '', durationSec: 0, views: Number(ch.statistics?.viewCount ?? 0), likes: 0, comments: 0,
      });
    }
  }
  return out;
}

// ── Analytics ───────────────────────────────────────────────
interface RawReport { columnHeaders?: { name: string }[]; rows?: (string | number)[][] }

/** YouTube Analytics API v2 (reports.query) — jeton de la chaîne, non décompté du quota Data API. */
export async function analytics(q: AnalyticsQuery): Promise<AnalyticsResult> {
  const params: Record<string, string> = { ids: 'channel==MINE', startDate: q.startDate, endDate: q.endDate, metrics: q.metrics.join(',') };
  if (q.dimensions?.length) params.dimensions = q.dimensions.join(',');
  if (q.filters) params.filters = q.filters;
  if (q.sort) params.sort = q.sort;
  if (q.maxResults) params.maxResults = String(q.maxResults);
  const today = new Date().toISOString().slice(0, 10);
  const ttl = q.endDate >= today ? 15 * 60_000 : 6 * 3600_000;
  const run = async (): Promise<AnalyticsResult> => {
    const token = await channelToken(q.channelId);
    let r: Response;
    try { r = await httpFetch(`${ANALYTICS_URL}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); }
    catch (e) { throw networkError('YouTube Analytics', e); }
    if (r.status === 401) { ytTokens.invalidate(q.channelId); throw new ConnectorError('YouTube Analytics : jeton expiré, nouvel essai…', { retryable: true, retryAfterMs: 50 }); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as YtErr;
      const msg = j.error?.message ?? '';
      if (r.status === 403 && /monetary|revenue|cpm|adImpressions/i.test(msg + q.metrics.join(',')))
        throw new ConnectorError('Les métriques de revenus nécessitent l’autorisation « rapports monétaires » (chaîne monétisée) — reconnecte la chaîne en l’acceptant.', { status: 403 });
      if (r.status === 403) throw new ConnectorError(`YouTube Analytics : accès refusé${msg ? ` (${msg})` : ''} — la chaîne doit être reconnectée avec l’autorisation Analytics.`, { status: 403, needsReauth: true });
      if (r.status === 400) throw new ConnectorError(`YouTube Analytics : requête refusée — ${msg || 'combinaison de métriques/dimensions non prise en charge'}.`, { status: 400 });
      if (r.status >= 500) throw new ConnectorError(`YouTube Analytics indisponible (erreur ${r.status}), nouvel essai…`, { retryable: true });
      throw new ConnectorError(`YouTube Analytics : ${msg || 'erreur ' + r.status}`, { status: r.status });
    }
    const j = await r.json() as RawReport;
    return { columns: (j.columnHeaders ?? []).map(c => c.name), rows: j.rows ?? [] };
  };
  const key = `yt:${q.channelId}:analytics?${stableKey(params)}`;
  return (await sharedCache().wrap(key, ttl, () => withRetry(run, { retries: 2 }))).value;
}
