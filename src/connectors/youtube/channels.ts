// Chaînes YouTube connectées : une autorisation OAuth par chaîne (chaînes de marque comprises :
// Google affiche le sélecteur de chaîne pendant le consentement, puis channels.list?mine=true l'identifie).
import { repo } from '../../db/store';
import { httpFetch } from '../../db/http';
import { toast } from '../../ui/appState';
import { YOUTUBE_SCOPES, type ConnectorAccount, type YtChannel } from '../api';
import { ConnectorError, networkError } from '../core/errors';
import { bumpConnectors, setBusy } from '../core/events';
import { sharedCache } from '../core/cache';
import { uniq } from '../core/queue';
import { authorize } from '../google/oauth';
import { OAuthTokenStore } from '../google/tokens';
import { hasScopes, missingScopes, normalizeScope } from '../google/accounts';
import { quotaRecord } from './quotaStore';

export interface YtChannelMeta {
  id: string; title: string; thumbnail: string; customUrl?: string;
  subscribers?: number; views?: number; videoCount?: number; hiddenSubscribers?: boolean;
  uploadsPlaylistId?: string; scopes: string[]; addedAt: number; needsReauth?: boolean;
}

export const YT_REQUIRED = [YOUTUBE_SCOPES.readonly, YOUTUBE_SCOPES.analytics];
export const YT_OPTIONAL = [YOUTUBE_SCOPES.manage, YOUTUBE_SCOPES.upload, YOUTUBE_SCOPES.monetary];

const KV = 'connectors:youtube:channels';
export const YT_API = 'https://www.googleapis.com/youtube/v3/';

let cached: YtChannelMeta[] | null = null;
export async function listChannels(): Promise<YtChannelMeta[]> {
  cached ??= (await repo.kvGet<YtChannelMeta[]>(KV)) ?? [];
  return cached;
}
async function saveChannels(list: YtChannelMeta[]) { cached = list; await repo.kvSet(KV, list); bumpConnectors(); }
export async function patchChannel(id: string, p: Partial<YtChannelMeta>) {
  await saveChannels((await listChannels()).map(c => (c.id === id ? { ...c, ...p } : c)));
}

export const ytTokens = new OAuthTokenStore('youtube.oauth.', 'YouTube', id => { void patchChannel(id, { needsReauth: true }); });

export const toYtChannel = (c: YtChannelMeta): YtChannel => ({ id: c.id, title: c.title, thumbnail: c.thumbnail, subscribers: c.subscribers, accountId: c.id });
export const toYtAccount = (c: YtChannelMeta): ConnectorAccount => ({
  id: c.id, label: c.title, avatar: c.thumbnail,
  meta: { subscribers: c.subscribers, customUrl: c.customUrl, videoCount: c.videoCount, needsReauth: !!c.needsReauth, monetary: hasScopes(c.scopes, [YOUTUBE_SCOPES.monetary]), upload: hasScopes(c.scopes, [YOUTUBE_SCOPES.upload]) || hasScopes(c.scopes, [YOUTUBE_SCOPES.manage]) },
});

export interface RawChannel {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}
export const bestThumb = (t?: Record<string, { url?: string }>) => t?.maxres?.url ?? t?.standard?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? '';

export function channelFromRaw(ch: RawChannel, prev?: Partial<YtChannelMeta>): Omit<YtChannelMeta, 'scopes' | 'addedAt'> {
  return {
    id: ch.id, title: ch.snippet?.title ?? prev?.title ?? ch.id, thumbnail: ch.snippet?.thumbnails?.high?.url ?? ch.snippet?.thumbnails?.medium?.url ?? bestThumb(ch.snippet?.thumbnails) ?? prev?.thumbnail ?? '',
    customUrl: ch.snippet?.customUrl ?? prev?.customUrl,
    subscribers: ch.statistics?.hiddenSubscriberCount ? undefined : ch.statistics?.subscriberCount != null ? Number(ch.statistics.subscriberCount) : prev?.subscribers,
    hiddenSubscribers: !!ch.statistics?.hiddenSubscriberCount,
    views: ch.statistics?.viewCount != null ? Number(ch.statistics.viewCount) : prev?.views,
    videoCount: ch.statistics?.videoCount != null ? Number(ch.statistics.videoCount) : prev?.videoCount,
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads ?? prev?.uploadsPlaylistId,
  };
}

async function fetchMine(accessToken: string): Promise<RawChannel | undefined> {
  let r: Response;
  try { r = await httpFetch(`${YT_API}channels?part=snippet,statistics,contentDetails&mine=true`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }); }
  catch (e) { throw networkError('YouTube', e); }
  await quotaRecord('channels.list');
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = j.error?.errors?.[0]?.reason;
    if (reason === 'accessNotConfigured') throw new ConnectorError('YouTube Data API v3 non activée dans ton projet Google Cloud (API et services → Bibliothèque).');
    throw new ConnectorError(`YouTube : ${j.error?.message ?? 'erreur ' + r.status}`);
  }
  const j = await r.json() as { items?: RawChannel[] };
  return j.items?.[0];
}

/**
 * Ajoute une chaîne : consentement Google (choisir le compte puis la chaîne, y compris une chaîne de marque),
 * puis identification par channels.list?mine=true. `expectId` : reconnexion d'une chaîne précise.
 */
export async function connectChannel(opts: { extraScopes?: string[]; expectId?: string } = {}): Promise<YtChannelMeta> {
  const prev = opts.expectId ? (await listChannels()).find(c => c.id === opts.expectId) : undefined;
  const scopes = uniq([...YT_REQUIRED, ...YT_OPTIONAL, ...(prev?.scopes ?? []), ...(opts.extraScopes ?? [])]);
  setBusy('youtube', 'Choisis le compte puis la chaîne dans ton navigateur…');
  try {
    const { tokens, granted } = await authorize({ scopes, prompt: 'select_account consent' });
    const miss = missingScopes(granted, YT_REQUIRED);
    if (miss.length) throw new ConnectorError('Autorisations YouTube insuffisantes : coche au minimum « Afficher votre compte YouTube » et « Afficher les rapports YouTube Analytics ».');
    const ch = await fetchMine(tokens.access_token);
    if (!ch) throw new ConnectorError('Ce compte Google n’a pas de chaîne YouTube. Crée-la sur youtube.com, ou choisis la chaîne (de marque) voulue dans l’écran de sélection.');
    if (opts.expectId && ch.id !== opts.expectId) throw new ConnectorError(`Tu as choisi une autre chaîne (${ch.snippet?.title ?? ch.id}) — choisis « ${prev?.title ?? opts.expectId} ».`);
    await ytTokens.save(ch.id, tokens);
    const list = await listChannels();
    const cur = list.find(c => c.id === ch.id);
    const meta: YtChannelMeta = { ...channelFromRaw(ch, cur), scopes: granted.map(normalizeScope), addedAt: cur?.addedAt ?? Date.now(), needsReauth: false };
    await saveChannels([...list.filter(c => c.id !== ch.id), meta]);
    const optMiss = missingScopes(meta.scopes, opts.extraScopes ?? []);
    if (optMiss.length) throw new ConnectorError('Autorisation demandée refusée : la fonction correspondante reste indisponible.');
    if (!hasScopes(meta.scopes, [YOUTUBE_SCOPES.monetary])) toast('Revenus YouTube non autorisés : les métriques de revenus resteront masquées.', 'info');
    return meta;
  } finally { setBusy('youtube'); }
}

export async function removeChannel(id: string) {
  // Pas de révocation : elle couperait aussi les autres connexions du même compte Google.
  await ytTokens.remove(id, false);
  await saveChannels((await listChannels()).filter(c => c.id !== id));
  await sharedCache().invalidate(`yt:${id}:`);
}

/** Jeton d'accès d'une chaîne connectée (avec scopes supplémentaires si demandés). */
export async function channelToken(channelId: string, scopes: string[] = []): Promise<string> {
  const ch = (await listChannels()).find(c => c.id === channelId);
  if (!ch) throw new ConnectorError(`La chaîne ${channelId} n’est pas connectée à Prisme — Réglages → Connexions → YouTube.`);
  if (scopes.length && !hasScopes(ch.scopes, scopes)) {
    toast(`Autorisation supplémentaire nécessaire pour « ${ch.title} » : choisis cette chaîne dans ton navigateur.`, 'info');
    await connectChannel({ extraScopes: scopes, expectId: channelId });
  }
  return ytTokens.accessToken(channelId);
}
