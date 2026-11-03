// Vidéo de référence : suggestions de gros YouTubeurs du même thème (search.list, 100 unités → cache 7 jours)
// et métriques publiques comparables (vues/jour depuis publication, durée, ratio j'aime, commentaires).
import { youtube, type YtVideo } from '../../../connectors/api';
import { cached, DAY, HOUR } from './cache';
import { keywordsFromTitle } from '../lib/structure';
import { viewsPerDay } from '../lib/series';
import { isShortForm } from './youtube';

export interface RefCandidate { video: YtVideo; subscribers: number | null; viewsPerDay: number }
export interface PublicMetrics { ageDays: number; viewsPerDay: number; likeRatio: number | null; commentsPer1k: number | null; durationSec: number; views: number; likes: number; comments: number }

export function publicMetrics(v: YtVideo, now = Date.now()): PublicMetrics {
  const ageDays = Math.max(1 / 24, (now - new Date(v.publishedAt).getTime()) / 86_400_000);
  return {
    ageDays,
    viewsPerDay: viewsPerDay(v.views, v.publishedAt, now),
    likeRatio: v.views > 0 && Number.isFinite(v.likes) ? v.likes / v.views : null,
    commentsPer1k: v.views > 0 && Number.isFinite(v.comments) ? (v.comments / v.views) * 1000 : null,
    durationSec: v.durationSec, views: v.views, likes: v.likes, comments: v.comments,
  };
}

/** Abonnés des chaînes (channels.list, 1 unité). null si indisponible (abonnés masqués). */
async function subscribersOf(channelIds: string[]): Promise<Map<string, number>> {
  const uniq = [...new Set(channelIds)].filter(Boolean).slice(0, 50);
  const map = new Map<string, number>();
  if (!uniq.length) return map;
  const r = await cached(`subs.${uniq.slice().sort().join(',')}`, 7 * DAY, async () => {
    const res = await youtube.data<{ items?: { id: string; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }>('channels', { part: 'statistics', id: uniq.join(',') });
    return (res.items ?? []).filter(i => i.statistics?.subscriberCount && !i.statistics.hiddenSubscriberCount).map(i => [i.id, Number(i.statistics!.subscriberCount)] as [string, number]);
  });
  for (const [id, n] of r.value) map.set(id, n);
  return map;
}

/**
 * Suggestions : recherche par mots-clés du titre (triée par vues), hors de ma chaîne, même format (court/long),
 * classées par vues/jour depuis publication, chaînes ≥ 100 k abonnés en priorité.
 */
export async function suggestReferences(video: YtVideo, opts: { force?: boolean; query?: string } = {}) {
  const q = (opts.query ?? keywordsFromTitle(video.title, video.tags ?? [])).trim() || video.title;
  const lang = /[àâçéèêëîïôûùüÿœ]/i.test(video.title + ' ' + video.description.slice(0, 300)) ? 'fr' : undefined;
  return cached(`refs.${q.toLowerCase()}.${isShortForm(video) ? 'court' : 'long'}`, 7 * DAY, async () => {
    const found = await youtube.search(q, { max: 25, order: 'viewCount', type: 'video', ...(lang ? { relevanceLanguage: lang } : {}) });
    const ids = found.filter(v => v.channelId !== video.channelId && v.id !== video.id).map(v => v.id);
    // search.list ne renvoie pas toujours statistiques/durée : on complète (videos.list, 1 unité).
    const full = ids.length ? await youtube.videos(ids.slice(0, 50)) : [];
    const sameFormat = full.filter(v => isShortForm(v) === isShortForm(video));
    const pool = sameFormat.length >= 3 ? sameFormat : full;
    const subs = await subscribersOf(pool.map(v => v.channelId)).catch(() => new Map<string, number>());
    const cands: RefCandidate[] = pool.map(v => ({ video: v, subscribers: subs.get(v.channelId) ?? null, viewsPerDay: viewsPerDay(v.views, v.publishedAt) }));
    const big = (c: RefCandidate) => (c.subscribers ?? 0) >= 100_000 ? 1 : 0;
    return { query: q, candidates: cands.sort((a, b) => big(b) - big(a) || b.viewsPerDay - a.viewsPerDay).slice(0, 8) };
  }, { force: opts.force });
}

/** Infos publiques d'une vidéo de référence (cache 6 h). */
export function referenceVideo(id: string, force = false) {
  return cached(`refvideo.${id}`, 6 * HOUR, async () => {
    const [v] = await youtube.videos([id]);
    if (!v) throw new Error('Vidéo de référence introuvable : supprimée, privée ou URL invalide.');
    return v;
  }, { force });
}
