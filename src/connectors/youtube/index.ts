// Connecteur YouTube : Data API v3 + Analytics API v2, plusieurs chaînes (une connexion OAuth par chaîne).
import { setYoutubeImpl, type Connector } from '../api';
import { chunk } from '../core/queue';
import { analytics, channelVideos, search, videos, ytData } from './client';
import { channelFromRaw, channelToken, connectChannel, listChannels, patchChannel, removeChannel, toYtAccount, toYtChannel, type RawChannel } from './channels';
import { quotaRecord, quotaState, quotaUsedToday } from './quotaStore';
import { methodKey } from '../core/quota';
import { youtubeTools } from './tools';
import { YoutubeSettings } from './YoutubeSettings';

/** Synchro : statistiques des chaînes (1 unité / 50 chaînes) + dernières vidéos en cache (lecture hors-ligne). */
async function syncYoutube() {
  const list = (await listChannels()).filter(c => !c.needsReauth);
  for (const ids of chunk(list.map(c => c.id), 50)) {
    const j = await ytData<{ items?: RawChannel[] }>('channels', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 }, { fresh: true });
    for (const raw of j.items ?? []) {
      const prev = list.find(c => c.id === raw.id);
      if (prev) await patchChannel(raw.id, channelFromRaw(raw, prev));
    }
  }
  for (const c of list) await channelVideos(c.id, { max: 50 });
}

export const youtubeConnector: Connector = {
  id: 'youtube',
  name: 'YouTube',
  icon: '▶️',
  description: 'Chaînes, vidéos, statistiques et publication — Data API v3 + Analytics, quota suivi en direct.',
  auth: { type: 'oauth', connect: async () => toYtAccount(await connectChannel()), disconnect: removeChannel },
  accounts: async () => (await listChannels()).map(toYtAccount),
  sync: syncYoutube,
  syncIntervalMin: 180,
  tools: youtubeTools,
  settings: YoutubeSettings,
};

setYoutubeImpl({
  channels: async () => (await listChannels()).map(toYtChannel),
  data: <T,>(path: string, params?: Record<string, string | number | boolean>, opts?: Parameters<typeof ytData>[2]) => ytData<T>(path, params ?? {}, opts ?? {}),
  analytics,
  videos,
  channelVideos,
  search,
  token: (channelId, scopes) => channelToken(channelId, scopes ?? []),
  quotaUsedToday,
  quota: quotaState,
  trackQuota: async (method, calls = 1) => quotaRecord(method.includes('.') ? method : methodKey(method, 'GET'), calls),
});
