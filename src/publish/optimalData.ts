// Collecte des données de l'heure optimale : vues des 48 premières heures de mes vidéos passées
// (instantanés kv 'stats:snapshots' en priorité, sinon YouTube Analytics jour par jour), mise en cache.
import { youtube } from '../connectors/api';
import { repo } from '../db/store';
import { computeOptimal, earlyViewsFromDaily, earlyViewsFromSnapshots, type EarlySample, type OptimalResult } from './optimal';
import { readSnapshots } from './snapshots';
import { addDays, ptDate } from './tz';
import { dailyVideoMetrics } from './youtubeApi';

type EarlyCache = Record<string, { publishedAt: number; early: number; source: EarlySample['source']; title?: string }>;
const DAY = 86_400_000;

export async function collectEarlySamples(channelId: string, onProgress?: (done: number, total: number) => void): Promise<EarlySample[]> {
  const videos = await youtube.channelVideos(channelId, { max: 50, order: 'date' });
  const now = Date.now();
  let eligible = videos.filter(v => now - Date.parse(v.publishedAt) > 4 * DAY);
  const longForm = eligible.filter(v => v.durationSec > 180);
  if (longForm.length >= 6) eligible = longForm; // Shorts et vidéos longues ont des dynamiques différentes
  eligible = eligible.slice(0, 40);
  const cacheKey = `publish:early:${channelId}`;
  const cache = (await repo.kvGet<EarlyCache>(cacheKey)) ?? {};
  const snaps = await readSnapshots();
  const out: EarlySample[] = [];
  let done = 0; let failures = 0;
  const queue = [...eligible];
  const worker = async () => {
    for (let v = queue.shift(); v; v = queue.shift()) {
      const publishedAt = Date.parse(v.publishedAt);
      const c = cache[v.id];
      if (c && c.publishedAt === publishedAt) out.push({ videoId: v.id, title: v.title, publishedAt, early: c.early, source: c.source });
      else {
        const fromSnaps = earlyViewsFromSnapshots(snaps.get(v.id) ?? [], publishedAt, 48);
        let early: number | null = fromSnaps; let source: EarlySample['source'] = 'snapshots';
        if (early == null && failures < 3) {
          try {
            const d0 = ptDate(publishedAt);
            const daily = await dailyVideoMetrics(channelId, v.id, d0, addDays(d0, 2));
            early = earlyViewsFromDaily(daily, publishedAt, 48, true); source = 'analytics';
          } catch { failures++; }
        }
        if (early != null) { cache[v.id] = { publishedAt, early, source, title: v.title }; out.push({ videoId: v.id, title: v.title, publishedAt, early, source }); }
      }
      onProgress?.(++done, eligible.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await repo.kvSet(cacheKey, cache);
  if (!out.length && failures) throw new Error('YouTube Analytics indisponible : reconnecte la chaîne avec l’accès aux statistiques.');
  return out;
}

export interface OptimalCached extends OptimalResult { at: number; channelId: string }
/** Résultat mis en cache 12 h (force = recalcul). */
export async function getOptimal(channelId: string, opts: { force?: boolean; onProgress?: (d: number, t: number) => void } = {}): Promise<OptimalCached> {
  const key = `publish:optimal:${channelId}`;
  const cached = await repo.kvGet<OptimalCached>(key);
  if (!opts.force && cached && Date.now() - cached.at < 12 * 3_600_000) return cached;
  const samples = await collectEarlySamples(channelId, opts.onProgress);
  const r: OptimalCached = { ...computeOptimal(samples), at: Date.now(), channelId };
  await repo.kvSet(key, r);
  return r;
}
export const peekOptimal = (channelId: string) => repo.kvGet<OptimalCached>(`publish:optimal:${channelId}`);
