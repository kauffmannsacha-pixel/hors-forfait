// Client REST Discord (API v10) : jeton de bot dans le coffre, limites de débit (429), erreurs lisibles.
import { httpFetch } from '../../db/http';
import { secrets } from '../../db/secrets';
import { repo } from '../../db/store';
import { sharedCache } from '../core/cache';
import { ConnectorError, networkError, sleep } from '../core/errors';
import { bumpConnectors } from '../core/events';
import { RequestQueue } from '../core/queue';
import type { DiscordPayload } from './convert';

const API = 'https://discord.com/api/v10';
const TOKEN = 'discord.bot_token';
const META_KV = 'connectors:discord:meta';
const queue = new RequestQueue(2, 250);

export interface DiscordMeta { botId: string; username: string; avatar?: string; addedAt: number }
export interface DiscordGuild { id: string; name: string; icon?: string | null }
export interface DiscordChannel { id: string; name: string; type: number; guildId: string; guild: string; category?: string; position: number }
export interface DiscordMessage {
  id: string; channel_id: string; content: string; timestamp: string; type: number;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  attachments?: { url: string; filename: string }[]; embeds?: { title?: string; description?: string; url?: string }[];
}

let tokenMem: string | null | undefined;
export async function getBotToken(): Promise<string | null> {
  if (tokenMem === undefined) tokenMem = (await secrets.get(TOKEN)) || null;
  return tokenMem;
}
export const getDiscordMeta = async () => (await repo.kvGet<DiscordMeta | null>(META_KV)) ?? null;

const CODES: Record<number, string> = {
  10003: 'salon introuvable (supprimé ?)', 10004: 'serveur introuvable', 50001: 'le bot n’a pas accès à ce salon (permissions « Voir le salon »)',
  50013: 'permissions manquantes (Envoyer des messages / Intégrer des liens)', 50035: 'message invalide (trop long ou mal formé)',
  40001: 'jeton du bot invalide', 50006: 'message vide', 50007: 'impossible d’écrire à cet utilisateur',
};

async function discordError(r: Response): Promise<ConnectorError> {
  let j: { message?: string; code?: number; errors?: unknown } = {};
  try { j = await r.json(); } catch { /* non JSON */ }
  const info = { service: 'Discord', status: r.status, code: String(j.code ?? r.status) };
  if (r.status === 401) return new ConnectorError('Discord : jeton du bot invalide ou réinitialisé — reconnecte Discord (Réglages → Connexions).', { ...info, needsReauth: true });
  if (r.status >= 500) return new ConnectorError(`Discord indisponible (erreur ${r.status}), nouvel essai…`, { ...info, retryable: true });
  const known = j.code !== undefined ? CODES[j.code] : undefined;
  return new ConnectorError(`Discord : ${known ?? j.message ?? 'erreur ' + r.status}${j.code === 50035 && j.errors ? ` — ${JSON.stringify(j.errors).slice(0, 160)}` : ''}`, info);
}

/** Requête authentifiée (respecte retry_after des 429, 3 tentatives max). */
export async function discordFetch<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? await getBotToken();
  if (!token) throw new ConnectorError('Discord n’est pas connecté — ajoute le jeton du bot dans Réglages → Connexions.');
  return queue.run(async () => {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await httpFetch(API + path, {
          method: init.method ?? 'GET',
          headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://github.com/prisme-app, 0.1.0)', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (e) { throw networkError('Discord', e); }
      if (r.status === 429 && attempt < 3) {
        const j = await r.json().catch(() => ({})) as { retry_after?: number };
        await sleep(Math.min(30_000, (j.retry_after ?? 1) * 1000 + 150));
        continue;
      }
      if (r.status >= 500 && attempt < 2) { await sleep(800 * 2 ** attempt); continue; }
      if (!r.ok) throw await discordError(r);
      if (r.status === 204) return undefined as T;
      return r.json() as Promise<T>;
    }
  });
}

export async function connectDiscord(rawToken: string): Promise<DiscordMeta> {
  const token = rawToken.trim().replace(/^Bot\s+/i, '');
  if (token.split('.').length !== 3) throw new ConnectorError('Le jeton d’un bot Discord compte trois parties séparées par des points (Developer Portal → Bot → Reset Token).');
  const me = await discordFetch<{ id: string; username: string; avatar?: string | null; bot?: boolean }>('/users/@me', { token });
  if (!me.bot) throw new ConnectorError('Ce jeton n’est pas celui d’un bot : utilise le jeton de l’onglet « Bot » du Developer Portal.');
  await secrets.set(TOKEN, token);
  tokenMem = token;
  const meta: DiscordMeta = { botId: me.id, username: me.username, avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : undefined, addedAt: Date.now() };
  await repo.kvSet(META_KV, meta);
  await sharedCache().invalidate('discord:');
  bumpConnectors();
  return meta;
}

export async function disconnectDiscord() {
  await secrets.del(TOKEN);
  tokenMem = null;
  await repo.kvSet(META_KV, null);
  await sharedCache().invalidate('discord:');
  bumpConnectors();
}

/** Lien d'invitation du bot (Voir les salons, Envoyer, Intégrer des liens, Joindre des fichiers, Lire l'historique). */
export const inviteUrl = (botId: string) => `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot&permissions=${1024 + 2048 + 16384 + 32768 + 65536}`;

const TEXT_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT

/** Salons textuels de tous les serveurs du bot (cache 10 min). */
export async function listTextChannels(force = false): Promise<DiscordChannel[]> {
  const { value } = await sharedCache().wrap('discord:channels', 10 * 60_000, async () => {
    const guilds = await discordFetch<DiscordGuild[]>('/users/@me/guilds?limit=200');
    const out: DiscordChannel[] = [];
    for (const g of guilds) {
      const chans = await discordFetch<{ id: string; name: string; type: number; position?: number; parent_id?: string | null }[]>(`/guilds/${g.id}/channels`);
      const cats = new Map(chans.filter(c => c.type === 4).map(c => [c.id, c.name]));
      for (const c of chans) if (TEXT_TYPES.has(c.type)) out.push({ id: c.id, name: c.name, type: c.type, guildId: g.id, guild: g.name, category: c.parent_id ? cats.get(c.parent_id) : undefined, position: c.position ?? 0 });
    }
    return out.sort((a, b) => a.guild.localeCompare(b.guild, 'fr') || (a.category ?? '').localeCompare(b.category ?? '', 'fr') || a.position - b.position);
  }, { force });
  return value;
}

/** Envoie une suite de messages (sans aucune mention @everyone / rôles / membres). */
export async function postPayloads(channelId: string, payloads: DiscordPayload[]): Promise<string[]> {
  const ids: string[] = [];
  for (const p of payloads) {
    const m = await discordFetch<{ id: string }>(`/channels/${channelId}/messages`, { method: 'POST', body: { ...p, allowed_mentions: { parse: [] } } });
    ids.push(m.id);
  }
  return ids;
}

/** Messages postérieurs à `after` (ordre chronologique), ou les `limit` plus récents. */
export async function fetchMessagesAfter(channelId: string, after?: string, limit = 50): Promise<DiscordMessage[]> {
  if (!after) {
    const recent = await discordFetch<DiscordMessage[]>(`/channels/${channelId}/messages?limit=${Math.min(100, limit)}`);
    return recent.sort((a, b) => cmpSnowflake(a.id, b.id));
  }
  const out: DiscordMessage[] = []; let cursor = after;
  for (let page = 0; page < 10; page++) {
    const batch = await discordFetch<DiscordMessage[]>(`/channels/${channelId}/messages?after=${cursor}&limit=100`);
    if (!batch.length) break;
    batch.sort((a, b) => cmpSnowflake(a.id, b.id));
    out.push(...batch);
    cursor = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return out;
}

/** Compare deux identifiants Discord (snowflakes 64 bits, chaînes décimales). */
export const cmpSnowflake = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
