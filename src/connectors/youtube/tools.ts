// Outils YouTube exposés à Claude (lecture seule).
import type { ClaudeTool } from '../../ui/registry';
import { errorMessage } from '../core/errors';
import { formatClock, localDayKey } from '../core/format';
import { analytics, channelVideos, search, ytData } from './client';
import { listChannels, type RawChannel } from './channels';
import { quotaState } from './quotaStore';

const clampInt = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export const youtubeTools: ClaudeTool[] = [
  {
    name: 'youtube_channel_stats',
    description: 'Statistiques YouTube des chaînes connectées à Prisme (ou d’une chaîne publique via son ID « UC… ») : abonnés, vues totales, nombre de vidéos, 10 dernières vidéos (vues, likes, commentaires, durée) et, pour les chaînes connectées, les totaux YouTube Analytics sur la période (vues, minutes regardées, durée et pourcentage moyens de visionnage, abonnés gagnés/perdus, likes, partages).',
    input_schema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'ID de chaîne (UC…). Laisser vide pour toutes les chaînes connectées.' },
        days: { type: 'integer', minimum: 1, maximum: 365, description: 'Période Analytics en jours (28 par défaut).' },
      },
    },
    run: async input => {
      const days = clampInt(input.days, 1, 365, 28);
      const connected = await listChannels();
      const ids = input.channelId ? [String(input.channelId).trim()] : connected.map(c => c.id);
      if (!ids.length) throw new Error('Aucune chaîne connectée — précise un channelId ou connecte une chaîne (Réglages → Connexions → YouTube).');
      const j = await ytData<{ items?: (RawChannel & { snippet?: { customUrl?: string } })[] }>('channels', { part: 'snippet,statistics', id: ids.join(','), maxResults: 50 });
      const end = new Date(); const start = new Date(Date.now() - days * 86_400_000);
      const channels = [];
      for (const id of ids) {
        const raw = j.items?.find(x => x.id === id);
        if (!raw) { channels.push({ channelId: id, error: 'Chaîne introuvable.' }); continue; }
        const recent = await channelVideos(id, { max: 10 }).catch(() => []);
        let stats: Record<string, number> | string | undefined;
        if (connected.some(c => c.id === id)) {
          try {
            const r = await analytics({ channelId: id, startDate: localDayKey(start), endDate: localDayKey(end), metrics: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares'] });
            stats = Object.fromEntries(r.columns.map((c, i) => [c, Number(r.rows[0]?.[i] ?? 0)]));
          } catch (e) { stats = `Analytics indisponible : ${errorMessage(e)}`; }
        }
        channels.push({
          channelId: id, title: raw.snippet?.title, handle: raw.snippet?.customUrl,
          subscribers: raw.statistics?.hiddenSubscriberCount ? 'masqué' : Number(raw.statistics?.subscriberCount ?? 0),
          totalViews: Number(raw.statistics?.viewCount ?? 0), videoCount: Number(raw.statistics?.videoCount ?? 0),
          recentVideos: recent.map(v => ({ id: v.id, title: v.title, publishedAt: v.publishedAt, views: v.views, likes: v.likes, comments: v.comments, duration: formatClock(v.durationSec), url: videoUrl(v.id) })),
          ...(stats !== undefined ? { analytics: { period: `${localDayKey(start)} → ${localDayKey(end)}`, ...(typeof stats === 'string' ? { error: stats } : stats) } } : {}),
        });
      }
      const q = await quotaState();
      return { channels, quota: q.buckets.map(b => `${b.label} : ${b.used}/${b.limit}`).join(' ; ') };
    },
  },
  {
    name: 'youtube_search',
    description: 'Recherche de vidéos (ou de chaînes) YouTube via l’API officielle, avec vues, likes, commentaires et durée. Coûte 1 appel du quota de recherche (100 par jour) — résultats mis en cache 12 h : évite les recherches redondantes.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Termes de recherche.' },
        max: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre de résultats (10 par défaut).' },
        order: { type: 'string', enum: ['relevance', 'viewCount', 'date'], description: 'Tri (pertinence par défaut).' },
        type: { type: 'string', enum: ['video', 'channel'], description: 'Vidéos (défaut) ou chaînes.' },
        regionCode: { type: 'string', description: 'Pays ISO 3166-1 alpha-2 (ex. FR).' },
        relevanceLanguage: { type: 'string', description: 'Langue ISO 639-1 (ex. fr).' },
      },
      required: ['query'],
    },
    run: async input => {
      const query = String(input.query ?? '').trim();
      if (!query) throw new Error('Paramètre « query » manquant.');
      const type = input.type === 'channel' ? 'channel' : 'video';
      const order = (['relevance', 'viewCount', 'date'] as const).find(o => o === input.order) ?? 'relevance';
      const res = await search(query, { max: clampInt(input.max, 1, 50, 10), order, type, regionCode: input.regionCode ? String(input.regionCode) : undefined, relevanceLanguage: input.relevanceLanguage ? String(input.relevanceLanguage) : undefined });
      return type === 'channel'
        ? { channels: res.map(c => ({ channelId: c.id, title: c.title, totalViews: c.views, url: `https://www.youtube.com/channel/${c.id}` })) }
        : { videos: res.map(v => ({ id: v.id, title: v.title, channel: v.channelTitle, channelId: v.channelId, publishedAt: v.publishedAt, views: v.views, likes: v.likes, comments: v.comments, duration: formatClock(v.durationSec), url: videoUrl(v.id) })) };
    },
  },
];
