// Accès aux données YouTube pour l'analyseur : Data API v3 (public) et Analytics API v2 (mes vidéos),
// via le contrat src/connectors/api.ts. Toutes les réponses passent par le cache kv (quota).
//
// Métriques utilisées — toutes vérifiées dans la doc officielle YouTube Analytics API v2 :
//   rétention : audienceWatchRatio, relativeRetentionPerformance (dimension elapsedVideoTimeRatio, filtre video==ID, option audienceType)
//   totaux / jour : views, engagedViews, estimatedMinutesWatched, averageViewDuration, averageViewPercentage,
//                   subscribersGained, subscribersLost, likes, dislikes, comments, shares, videosAddedToPlaylists
//   répartitions : insightTrafficSourceType, country, deviceType (métriques views, estimatedMinutesWatched)
//   revenus (scope yt-analytics-monetary.readonly + Programme Partenaire) : estimatedRevenue, estimatedAdRevenue,
//                   grossRevenue, cpm, playbackBasedCpm, monetizedPlaybacks, adImpressions
// Absents de l'API Analytics (requêtes ciblées) : vues par heure (pas de dimension « hour »), impressions et CTR des
// miniatures (fournis uniquement par l'API YouTube Reporting, voir reporting.ts).
import { youtube, type AnalyticsQuery, type AnalyticsResult, type YtChannel, type YtVideo } from '../../../connectors/api';
import { getTranscript, type Transcript } from '../../../knowledge/api';
import { cached, DAY, HOUR, MIN, type Fetched } from './cache';
import { isBadRequest, isForbidden, explainError } from './errors';
import { addDays, dateInTz } from '../lib/series';
import { parseRetentionRows, type RetentionPoint } from '../lib/retention';
import type { AudienceType } from '../lib/labels';

export const todayPT = () => dateInTz(Date.now());
export const publishedPT = (v: Pick<YtVideo, 'publishedAt'>) => dateInTz(new Date(v.publishedAt).getTime());
export const ageHours = (v: Pick<YtVideo, 'publishedAt'>, now = Date.now()) => (now - new Date(v.publishedAt).getTime()) / 3_600_000;
/** Format court (Short) si ≤ 3 min — l'API Data ne distingue pas les Shorts : heuristique de durée. */
export const isShortForm = (v: Pick<YtVideo, 'durationSec'>) => v.durationSec > 0 && v.durationSec <= 180;

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export function toObjects(res: AnalyticsResult): Record<string, string | number>[] {
  return (res.rows ?? []).map(r => Object.fromEntries((res.columns ?? []).map((c, i) => [c, r[i]])));
}
const run = (q: AnalyticsQuery) => youtube.analytics(q);

// ── Chaînes et vidéos ───────────────────────────────────────
/** Chaînes connectées (OAuth). Vide si YouTube n'est pas connecté. */
export async function myChannels(): Promise<YtChannel[]> {
  try { return await youtube.channels(); } catch { return []; }
}
export const ownerOf = (v: Pick<YtVideo, 'channelId'>, channels: YtChannel[]) => channels.find(c => c.id === v.channelId) ?? null;

export function getVideo(id: string, force = false): Promise<Fetched<YtVideo>> {
  return cached(`video.${id}`, 10 * MIN, async () => {
    const [v] = await youtube.videos([id]);
    if (!v) throw new Error('Vidéo introuvable : supprimée, privée ou URL invalide.');
    return v;
  }, { force });
}
/** Infos publiques de plusieurs vidéos (videos.list : 1 unité par lot de 50). */
export async function getVideos(ids: string[], ttl = 30 * MIN): Promise<YtVideo[]> {
  const uniq = [...new Set(ids)].filter(Boolean);
  const out: YtVideo[] = [];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const r = await cached(`videos.${chunk.slice().sort().join(',')}`, ttl, () => youtube.videos(chunk));
    out.push(...r.value);
  }
  return out;
}
/** Dernières vidéos d'une chaîne (les miennes via OAuth, ou publiques). */
export function channelVideos(channelId: string, force = false, max = 50): Promise<Fetched<YtVideo[]>> {
  return cached(`chvideos.${channelId}.${max}`, 30 * MIN, () => youtube.channelVideos(channelId, { max, order: 'date' }), { force });
}
/** Les N vidéos publiées juste avant celle-ci, de même format (court/long) si possible. */
export function previousVideos(all: YtVideo[], video: YtVideo, n = 10): YtVideo[] {
  const before = all
    .filter(v => v.id !== video.id && new Date(v.publishedAt).getTime() < new Date(video.publishedAt).getTime())
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const same = before.filter(v => isShortForm(v) === isShortForm(video));
  return (same.length >= 3 ? same : before).slice(0, n);
}

// ── Rétention ───────────────────────────────────────────────
export interface RetentionData { points: RetentionPoint[]; hasRelative: boolean; audience: AudienceType }
export function getRetention(channelId: string, video: YtVideo, audience: AudienceType = 'ALL', force = false): Promise<Fetched<RetentionData>> {
  return cached(`ret.${video.id}.${audience}`, 6 * HOUR, async () => {
    const filters = [`video==${video.id}`];
    if (audience !== 'ALL') filters.push(`audienceType==${audience}`);
    const q: AnalyticsQuery = {
      channelId, metrics: ['audienceWatchRatio', 'relativeRetentionPerformance'], dimensions: ['elapsedVideoTimeRatio'],
      filters: filters.join(';'), startDate: publishedPT(video), endDate: todayPT(),
    };
    let res: AnalyticsResult;
    try { res = await run(q); } catch (e) {
      // relativeRetentionPerformance n'est pas fourni pour toutes les vidéos : on retente sans.
      if (!isBadRequest(e)) throw e;
      res = await run({ ...q, metrics: ['audienceWatchRatio'] });
    }
    const points = parseRetentionRows(res.columns, res.rows);
    return { points, hasRelative: points.some(p => p.relative != null), audience };
  }, { force });
}

// ── Totaux ──────────────────────────────────────────────────
export interface Totals {
  views: number | null; engagedViews: number | null; minutes: number | null; avgDuration: number | null; avgPct: number | null;
  subsGained: number | null; subsLost: number | null; likes: number | null; dislikes: number | null; comments: number | null;
  shares: number | null; playlistAdds: number | null; empty: boolean;
}
const TOTALS_FULL = ['views', 'engagedViews', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'subscribersLost', 'likes', 'dislikes', 'comments', 'shares', 'videosAddedToPlaylists'];
const TOTALS_CORE = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares'];
export function getTotals(channelId: string, video: YtVideo, force = false): Promise<Fetched<Totals>> {
  return cached(`tot.${video.id}`, HOUR, async () => {
    const base = { channelId, filters: `video==${video.id}`, startDate: publishedPT(video), endDate: todayPT() };
    let res: AnalyticsResult;
    try { res = await run({ ...base, metrics: TOTALS_FULL }); } catch (e) {
      if (!isBadRequest(e)) throw e;
      res = await run({ ...base, metrics: TOTALS_CORE });
    }
    const o = toObjects(res)[0] ?? {};
    return {
      views: num(o.views), engagedViews: num(o.engagedViews), minutes: num(o.estimatedMinutesWatched),
      avgDuration: num(o.averageViewDuration), avgPct: num(o.averageViewPercentage),
      subsGained: num(o.subscribersGained), subsLost: num(o.subscribersLost), likes: num(o.likes), dislikes: num(o.dislikes),
      comments: num(o.comments), shares: num(o.shares), playlistAdds: num(o.videosAddedToPlaylists), empty: !res.rows?.length,
    };
  }, { force });
}

// ── Vues par jour ───────────────────────────────────────────
export interface DailyRow { date: string; views: number; minutes: number | null; avgPct: number | null; subsGained: number | null; subsLost: number | null }
export function getDaily(channelId: string, videoId: string, start: string, end: string, force = false): Promise<Fetched<DailyRow[]>> {
  // Les jours de plus de 3 jours sont consolidés : cache long.
  const ttl = end < addDays(todayPT(), -3) ? 7 * DAY : 3 * HOUR;
  return cached(`day.${videoId}.${start}.${end}`, ttl, async () => {
    if (end < start) return [];
    const res = await run({
      channelId, metrics: ['views', 'estimatedMinutesWatched', 'averageViewPercentage', 'subscribersGained', 'subscribersLost'],
      dimensions: ['day'], filters: `video==${videoId}`, startDate: start, endDate: end, sort: 'day',
    });
    return toObjects(res).map(o => ({
      date: String(o.day), views: num(o.views) ?? 0, minutes: num(o.estimatedMinutesWatched), avgPct: num(o.averageViewPercentage),
      subsGained: num(o.subscribersGained), subsLost: num(o.subscribersLost),
    }));
  }, { force });
}

// ── Répartitions ────────────────────────────────────────────
export type BreakdownDim = 'insightTrafficSourceType' | 'country' | 'deviceType';
export interface BreakdownRow { key: string; views: number; minutes: number | null }
export function getBreakdown(channelId: string, video: YtVideo, dim: BreakdownDim, force = false): Promise<Fetched<BreakdownRow[]>> {
  return cached(`bd.${dim}.${video.id}`, 3 * HOUR, async () => {
    const res = await run({
      channelId, metrics: ['views', 'estimatedMinutesWatched'], dimensions: [dim], filters: `video==${video.id}`,
      startDate: publishedPT(video), endDate: todayPT(), sort: '-views',
    });
    return toObjects(res)
      .map(o => ({ key: String(o[dim] ?? ''), views: num(o.views) ?? 0, minutes: num(o.estimatedMinutesWatched) }))
      .filter(r => r.key)
      .sort((a, b) => b.views - a.views);
  }, { force });
}

// ── Revenus (Programme Partenaire + scope monétaire) ────────
export type Revenue =
  | { available: true; estimatedRevenue: number | null; estimatedAdRevenue: number | null; grossRevenue: number | null; cpm: number | null; playbackBasedCpm: number | null; monetizedPlaybacks: number | null; adImpressions: number | null; currency: 'USD' }
  | { available: false; reason: string };
const REVENUE_SETS = [
  ['estimatedRevenue', 'estimatedAdRevenue', 'grossRevenue', 'cpm', 'playbackBasedCpm', 'monetizedPlaybacks', 'adImpressions'],
  ['estimatedRevenue', 'estimatedAdRevenue', 'cpm', 'playbackBasedCpm', 'monetizedPlaybacks'],
  ['estimatedRevenue'],
];
export function getRevenue(channelId: string, video: YtVideo, force = false): Promise<Fetched<Revenue>> {
  return cached(`rev.${video.id}`, 6 * HOUR, async (): Promise<Revenue> => {
    const base = { channelId, filters: `video==${video.id}`, startDate: publishedPT(video), endDate: todayPT() };
    let lastErr: unknown = null;
    for (const metrics of REVENUE_SETS) {
      try {
        const o = toObjects(await run({ ...base, metrics }))[0] ?? {};
        return {
          available: true, currency: 'USD',
          estimatedRevenue: num(o.estimatedRevenue), estimatedAdRevenue: num(o.estimatedAdRevenue), grossRevenue: num(o.grossRevenue),
          cpm: num(o.cpm), playbackBasedCpm: num(o.playbackBasedCpm), monetizedPlaybacks: num(o.monetizedPlaybacks), adImpressions: num(o.adImpressions),
        };
      } catch (e) {
        lastErr = e;
        if (isForbidden(e)) return { available: false, reason: explainError(e, 'monetary') };
        if (!isBadRequest(e)) throw e;
      }
    }
    return { available: false, reason: explainError(lastErr, 'monetary') };
  }, { force });
}

// ── Transcription ───────────────────────────────────────────
export function getTranscriptCached(videoId: string, force = false): Promise<Fetched<Transcript>> {
  return cached(`tr.${videoId}`, 30 * DAY, () => getTranscript(videoId), { force });
}

// ── Quota ───────────────────────────────────────────────────
export async function quotaToday(): Promise<number | null> {
  try { return await youtube.quotaUsedToday(); } catch { return null; }
}
