// Données YouTube (API officielle Data v3 via le connecteur) : vidéos les plus vues d'une niche ou d'une chaîne,
// abonnés des chaînes (performance vues/abonnés). Mise en cache des statistiques de chaînes (7 jours).
import { youtube, type YtVideo } from '../../../connectors/api';
import { loadChannelStats, saveChannelStats, type ChannelStat } from './store';

interface ChannelsList { items?: { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }
interface SearchList { items?: { id?: { videoId?: string; channelId?: string } }[] }

export type ChannelRef = { kind: 'id'; id: string } | { kind: 'handle'; handle: string } | { kind: 'user'; name: string } | { kind: 'search'; q: string };
/** Interprète une saisie de chaîne : URL, @pseudo, identifiant UC…, ou nom à rechercher. */
export function parseChannelInput(input: string): ChannelRef {
  const s = input.trim();
  const id = /(?:youtube\.com\/channel\/)?(UC[\w-]{22})\b/.exec(s)?.[1];
  if (id) return { kind: 'id', id };
  const handle = /youtube\.com\/(@[\w.\-·]+)/i.exec(s)?.[1] ?? (/^@[\w.\-·]+$/.test(s) ? s : undefined);
  if (handle) return { kind: 'handle', handle };
  const user = /youtube\.com\/user\/([\w.-]+)/i.exec(s)?.[1];
  if (user) return { kind: 'user', name: user };
  const custom = /youtube\.com\/c\/([^/?#]+)/i.exec(s)?.[1];
  return { kind: 'search', q: custom ? decodeURIComponent(custom) : s };
}

const toNum = (v?: string) => (v == null || v === '' ? undefined : Number(v));

export async function resolveChannel(input: string): Promise<{ id: string; title: string; subscribers?: number }> {
  const ref = parseChannelInput(input);
  if (!input.trim()) throw new Error('Indique une chaîne (URL, @pseudo ou identifiant).');
  let params: Record<string, string>;
  if (ref.kind === 'id') params = { id: ref.id };
  else if (ref.kind === 'handle') params = { forHandle: ref.handle };
  else if (ref.kind === 'user') params = { forUsername: ref.name };
  else {
    const res = await youtube.data<SearchList>('search', { part: 'snippet', q: ref.q, type: 'channel', maxResults: 1 });
    const cid = res.items?.[0]?.id?.channelId;
    if (!cid) throw new Error(`Aucune chaîne trouvée pour « ${ref.q} ».`);
    params = { id: cid };
  }
  const res = await youtube.data<ChannelsList>('channels', { part: 'snippet,statistics', ...params });
  const it = res.items?.[0];
  if (!it) throw new Error('Chaîne introuvable : vérifie l\'URL ou le @pseudo.');
  return { id: it.id, title: it.snippet?.title ?? it.id, subscribers: it.statistics?.hiddenSubscriberCount ? undefined : toNum(it.statistics?.subscriberCount) };
}

const WEEK = 7 * 86400_000;
/** Abonnés des chaînes (lots de 50, 1 unité de quota par lot), avec cache kv. */
export async function channelStats(ids: string[]): Promise<Record<string, ChannelStat>> {
  const cache = await loadChannelStats();
  const missing = [...new Set(ids)].filter(id => !cache[id] || Date.now() - cache[id].fetchedAt > WEEK);
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const res = await youtube.data<ChannelsList>('channels', { part: 'snippet,statistics', id: batch.join(','), maxResults: 50 });
    for (const it of res.items ?? []) cache[it.id] = { title: it.snippet?.title ?? '', subscribers: it.statistics?.hiddenSubscriberCount ? undefined : toNum(it.statistics?.subscriberCount), fetchedAt: Date.now() };
  }
  if (missing.length) await saveChannelStats(cache);
  return cache;
}

export type Period = 'tout' | '12m' | '3m';
export interface TopVideosOpts { mode: 'niche' | 'chaine'; query: string; max: number; excludeShorts: boolean; lang: '' | 'fr' | 'en'; period: Period }
const isShort = (v: YtVideo) => v.durationSec > 0 && v.durationSec <= 60;

/** Vidéos les plus vues d'une niche (recherche triée par vues) ou d'une chaîne. */
export async function topVideos(o: TopVideosOpts): Promise<{ videos: YtVideo[]; label: string; channelId?: string; quotaHint: number }> {
  const want = Math.max(1, Math.min(50, o.max));
  const fetchN = Math.min(50, o.excludeShorts ? want * 2 : want);
  let videos: YtVideo[]; let label = o.query.trim(); let channelId: string | undefined; let quotaHint = 0;
  if (o.mode === 'chaine') {
    const ch = await resolveChannel(o.query); channelId = ch.id; label = ch.title;
    videos = await youtube.channelVideos(ch.id, { max: fetchN, order: 'viewCount' }); quotaHint = 102;
  } else {
    if (!label) throw new Error('Indique une niche à analyser (ex. « minecraft survie », « finance perso »).');
    const lang = o.lang || undefined, region = o.lang === 'fr' ? 'FR' : o.lang === 'en' ? 'US' : undefined;
    if (o.period !== 'tout') {
      const after = new Date(Date.now() - (o.period === '12m' ? 365 : 92) * 86400_000).toISOString();
      const res = await youtube.data<SearchList>('search', { part: 'snippet', q: label, type: 'video', order: 'viewCount', maxResults: fetchN, publishedAfter: after, ...(lang ? { relevanceLanguage: lang } : {}), ...(region ? { regionCode: region } : {}) });
      const ids = (res.items ?? []).map(i => i.id?.videoId).filter((x): x is string => !!x);
      videos = ids.length ? await youtube.videos(ids) : [];
      const order = new Map(ids.map((id, i) => [id, i])); videos.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } else {
      videos = await youtube.search(label, { max: fetchN, order: 'viewCount', type: 'video', relevanceLanguage: lang, regionCode: region });
    }
    quotaHint = 101;
  }
  // statistiques manquantes (certaines réponses de recherche n'ont pas les vues/durées)
  const incomplete = videos.filter(v => !v.views && !v.durationSec).map(v => v.id);
  if (incomplete.length) {
    const full = new Map((await youtube.videos(incomplete)).map(v => [v.id, v]));
    videos = videos.map(v => full.get(v.id) ?? v);
  }
  if (o.excludeShorts) videos = videos.filter(v => !isShort(v));
  videos.sort((a, b) => b.views - a.views);
  return { videos: videos.slice(0, want), label, channelId, quotaHint };
}

export const nicheKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
