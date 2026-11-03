// Quota YouTube Data API v3 — logique pure (testée).
// Source : developers.google.com/youtube/v3/determine_quota_cost (révision du 1er juin 2026) :
//  • `search.list` et `videos.insert` ont chacun leur propre « bucket » : 100 appels / jour, 1 unité par appel ;
//  • `videos.batchGetStats` : bucket dédié de 10 000 unités / jour, 1 unité par appel ;
//  • toutes les autres méthodes partagent 10 000 unités / jour (coûts ci-dessous) ;
//  • toute requête, même invalide, coûte au moins 1 unité ; remise à zéro à minuit, heure du Pacifique.
import type { QuotaBucket } from '../api';

export const PACIFIC_TZ = 'America/Los_Angeles';

export const QUOTA_BUCKETS: { id: QuotaBucket; label: string; unit: string }[] = [
  { id: 'default', label: 'Quota général', unit: 'unités' },
  { id: 'search', label: 'Recherches (search.list)', unit: 'appels' },
  { id: 'upload', label: 'Mises en ligne (videos.insert)', unit: 'appels' },
  { id: 'batchStats', label: 'Statistiques groupées (videos.batchGetStats)', unit: 'appels' },
];

export const DEFAULT_LIMITS: Record<QuotaBucket, number> = { default: 10_000, search: 100, upload: 100, batchStats: 10_000 };

/** Coûts du bucket général par méthode (« resource.method »). */
export const QUOTA_COSTS: Record<string, number> = {
  'activities.list': 1,
  'captions.list': 50, 'captions.insert': 400, 'captions.update': 450, 'captions.delete': 50, 'captions.download': 200,
  'channelBanners.insert': 50,
  'channels.list': 1, 'channels.update': 50,
  'channelSections.list': 1, 'channelSections.insert': 50, 'channelSections.update': 50, 'channelSections.delete': 50,
  'comments.list': 1, 'comments.insert': 50, 'comments.update': 50, 'comments.setModerationStatus': 50, 'comments.delete': 50,
  'commentThreads.list': 1, 'commentThreads.insert': 50, 'commentThreads.update': 50,
  'guideCategories.list': 1, 'i18nLanguages.list': 1, 'i18nRegions.list': 1,
  'liveBroadcasts.bind': 1, 'liveBroadcasts.delete': 1, 'liveBroadcasts.insert': 1, 'liveBroadcasts.insertCuepoint': 1,
  'liveBroadcasts.list': 1, 'liveBroadcasts.transition': 1, 'liveBroadcasts.update': 1,
  'liveChatBans.delete': 200, 'liveChatBans.insert': 200,
  'liveChatMessages.delete': 20, 'liveChatMessages.insert': 20, 'liveChatMessages.list': 5, 'liveChatMessages.streamList': 5, 'liveChatMessages.transition': 20,
  'liveChatModerators.delete': 200, 'liveChatModerators.insert': 200, 'liveChatModerators.list': 50,
  'liveStreams.delete': 1, 'liveStreams.insert': 1, 'liveStreams.list': 1, 'liveStreams.update': 1,
  'members.list': 1, 'membershipsLevels.list': 1,
  'playlistItems.list': 1, 'playlistItems.insert': 50, 'playlistItems.update': 50, 'playlistItems.delete': 50,
  'playlists.list': 1, 'playlists.insert': 50, 'playlists.update': 50, 'playlists.delete': 50,
  'subscriptions.list': 1, 'subscriptions.insert': 50, 'subscriptions.delete': 50,
  'superChatEvents.list': 1,
  'thumbnails.set': 50,
  'videoAbuseReportReasons.list': 1, 'videoCategories.list': 1,
  'videos.list': 1, 'videos.update': 50, 'videos.rate': 50, 'videos.getRating': 1, 'videos.reportAbuse': 50, 'videos.delete': 50,
  'watermarks.set': 50, 'watermarks.unset': 50,
};

/** Méthodes facturées dans un bucket dédié (1 par appel). */
const OWN_BUCKET: Record<string, QuotaBucket> = { 'search.list': 'search', 'videos.insert': 'upload', 'videos.batchGetStats': 'batchStats' };

const VERB: Record<string, string> = { GET: 'list', POST: 'insert', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/**
 * Déduit « resource.method » d'un chemin d'API relatif à /youtube/v3/ et d'un verbe HTTP.
 * Ex. ('videos','GET') → videos.list · ('thumbnails/set','POST') → thumbnails.set · ('captions/ID','GET') → captions.download.
 */
export function methodKey(path: string, httpMethod = 'GET'): string {
  const clean = path.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/^(upload\/)?youtube\/v3\//, '').replace(/\/+$/, '');
  const verb = httpMethod.toUpperCase();
  const colon = clean.match(/^([A-Za-z0-9]+):([A-Za-z0-9]+)$/); // videos:batchGetStats
  if (colon) return `${colon[1]}.${colon[2]}`;
  const [resource = '', sub] = clean.split('/');
  if (sub) {
    if (resource === 'captions' && verb === 'GET') return 'captions.download';
    if (resource === 'thumbnails' && sub === 'set') return 'thumbnails.set';
    if (resource === 'channelBanners' && sub === 'insert') return 'channelBanners.insert';
    if (resource === 'watermarks') return `watermarks.${sub}`;
    if (/^[a-z][A-Za-z]+$/.test(sub)) return `${resource}.${sub}`; // videos/rate, comments/setModerationStatus…
  }
  return `${resource}.${VERB[verb] ?? 'list'}`;
}

/** Bucket et coût d'une méthode (méthode inconnue : 1 unité, prudence). */
export function quotaCost(key: string): { bucket: QuotaBucket; cost: number } {
  const own = OWN_BUCKET[key];
  if (own) return { bucket: own, cost: 1 };
  return { bucket: 'default', cost: QUOTA_COSTS[key] ?? 1 };
}

/** true pour les méthodes de lecture (soumises à la réserve de sécurité). */
export const isReadMethod = (key: string) => /\.(list|getRating|download|batchGetStats)$/.test(key);

// ── Fuseau du Pacifique ───────────────────────────────────────
function tzParts(d: Date, tz = PACIFIC_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** Décalage (ms) entre l'heure locale du fuseau et UTC à l'instant donné (négatif pour le Pacifique). */
export function tzOffsetMs(d: Date, tz = PACIFIC_TZ): number {
  const p = tzParts(d, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - (d.getTime() - d.getMilliseconds());
}

/** Jour de quota courant (AAAA-MM-JJ, heure du Pacifique). */
export function pacificDayKey(d: Date = new Date()): string {
  const p = tzParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Prochaine remise à zéro du quota (minuit, heure du Pacifique) — gère les changements d'heure. */
export function nextPacificMidnight(d: Date = new Date()): Date {
  const p = tzParts(d);
  const midnightLocalAsUtc = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0);
  let t = midnightLocalAsUtc - tzOffsetMs(d);
  // Deux passes : le décalage à minuit peut différer de l'actuel (nuit du changement d'heure).
  for (let i = 0; i < 2; i++) t = midnightLocalAsUtc - tzOffsetMs(new Date(t));
  return new Date(t);
}

// ── Grand livre du jour ───────────────────────────────────────
export interface QuotaLedger { day: string; used: Record<QuotaBucket, number>; byMethod: Record<string, number> }

export const emptyLedger = (day: string): QuotaLedger => ({ day, used: { default: 0, search: 0, upload: 0, batchStats: 0 }, byMethod: {} });

/** Ledger valable pour `day` (remis à zéro si on a changé de jour Pacifique). */
export const ledgerFor = (l: QuotaLedger | null | undefined, day: string): QuotaLedger =>
  l && l.day === day ? { day, used: { ...emptyLedger(day).used, ...l.used }, byMethod: { ...l.byMethod } } : emptyLedger(day);

/** Enregistre `calls` appels de `key` (pur : renvoie un nouveau ledger). */
export function charge(l: QuotaLedger | null | undefined, day: string, key: string, calls = 1): QuotaLedger {
  const next = ledgerFor(l, day);
  const { bucket, cost } = quotaCost(key);
  next.used[bucket] += cost * calls;
  next.byMethod[key] = (next.byMethod[key] ?? 0) + cost * calls;
  return next;
}

/**
 * Peut-on dépenser pour `key` ? Les lectures du bucket général s'arrêtent à `limit - reserve`
 * pour garder de quoi publier (miniatures, mises à jour, sous-titres…).
 */
export function canSpend(l: QuotaLedger | null | undefined, day: string, key: string, limits: Record<QuotaBucket, number>, reserve = 0): { ok: boolean; bucket: QuotaBucket; cost: number; remaining: number } {
  const cur = ledgerFor(l, day);
  const { bucket, cost } = quotaCost(key);
  const limit = limits[bucket] ?? DEFAULT_LIMITS[bucket];
  const ceiling = bucket === 'default' && isReadMethod(key) ? Math.max(0, limit - reserve) : limit;
  const remaining = ceiling - cur.used[bucket];
  return { ok: cur.used[bucket] + cost <= ceiling, bucket, cost, remaining };
}
