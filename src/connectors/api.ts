// ─────────────────────────────────────────────────────────────
// CONTRAT Connecteurs — implémenté par le module connectors.
// Les autres modules appellent youtube / google / stripe / discord via ces fonctions.
// ─────────────────────────────────────────────────────────────
import type { ComponentType } from 'react';
import type { AnyExtension } from '@tiptap/core';
import type { ClaudeTool } from '../ui/registry';

export interface ConnectorAccount { id: string; label: string; avatar?: string; meta?: Record<string, unknown> }
export interface Connector {
  id: string; name: string; icon: string; description: string;
  auth: { type: 'oauth' | 'apikey' | 'local'; connect: () => Promise<ConnectorAccount>; disconnect: (accountId: string) => Promise<void> };
  accounts: () => Promise<ConnectorAccount[]>;
  sync?: () => Promise<void>;               // synchro arrière-plan
  syncIntervalMin?: number;
  blocks?: AnyExtension[];                  // blocs éditeur fournis
  tools?: ClaudeTool[];                     // outils pour Claude
  settings?: ComponentType;                 // réglages spécifiques
}
export const connectors: Connector[] = [];
export const registerConnector = (c: Connector) => { if (!connectors.find(x => x.id === c.id)) connectors.push(c); };

// ── YouTube ──────────────────────────────────────────────────
export interface YtChannel { id: string; title: string; thumbnail: string; subscribers?: number; accountId: string }
export interface YtVideo {
  id: string; title: string; description: string; publishedAt: string; thumbnail: string; channelId: string; channelTitle: string;
  durationSec: number; views: number; likes: number; comments: number; tags?: string[]; categoryId?: string;
}
export interface AnalyticsQuery { channelId: string; metrics: string[]; dimensions?: string[]; filters?: string; startDate: string; endDate: string; sort?: string; maxResults?: number }
export interface AnalyticsResult { columns: string[]; rows: (string | number)[][] }

type YtImpl = {
  channels: () => Promise<YtChannel[]>;                                    // chaînes connectées (multi-comptes)
  /** Appel brut YouTube Data API v3 (GET/POST…) ; channelId => token OAuth de cette chaîne, sinon clé API. */
  data: <T = unknown>(path: string, params?: Record<string, string | number | boolean>, opts?: { channelId?: string; method?: string; body?: unknown }) => Promise<T>;
  analytics: (q: AnalyticsQuery) => Promise<AnalyticsResult>;               // YouTube Analytics API v2 (reports.query)
  videos: (ids: string[]) => Promise<YtVideo[]>;                            // infos publiques
  channelVideos: (channelId: string, opts?: { max?: number; order?: 'date' | 'viewCount' }) => Promise<YtVideo[]>;
  search: (q: string, opts?: { max?: number; order?: 'relevance' | 'viewCount' | 'date'; type?: 'video' | 'channel'; channelId?: string; regionCode?: string; relevanceLanguage?: string }) => Promise<YtVideo[]>;
  /** Jeton OAuth valide pour une chaîne (upload, analytics…). */
  token: (channelId: string) => Promise<string>;
  quotaUsedToday: () => Promise<number>;
};
// ── Google (Gmail / Calendar / Drive) ────────────────────────
type GoogleImpl = {
  accounts: () => Promise<ConnectorAccount[]>;
  token: (accountId: string, scopes: string[]) => Promise<string>;          // ajoute les scopes si besoin (consentement)
  connect: (scopes: string[]) => Promise<ConnectorAccount>;
};
// ── Stripe / Discord ─────────────────────────────────────────
type StripeImpl = { get: <T = unknown>(path: string, params?: Record<string, string | number>) => Promise<T>; connected: () => Promise<boolean> };
type DiscordImpl = { send: (channelId: string, content: string, opts?: { embeds?: unknown[] }) => Promise<void>; channels: () => Promise<{ id: string; name: string; guild: string }[]> };

const nc = (s: string) => async (): Promise<never> => { throw new Error(`${s} n'est pas connecté — Réglages → Connexions.`); };
let yt: YtImpl = { channels: async () => [], data: nc('YouTube'), analytics: nc('YouTube'), videos: nc('YouTube'), channelVideos: nc('YouTube'), search: nc('YouTube'), token: nc('YouTube'), quotaUsedToday: async () => 0 };
let gg: GoogleImpl = { accounts: async () => [], token: nc('Google'), connect: nc('Google') };
let st: StripeImpl = { get: nc('Stripe'), connected: async () => false };
let dc: DiscordImpl = { send: nc('Discord'), channels: async () => [] };
export const setYoutubeImpl = (i: YtImpl) => { yt = i; };
export const setGoogleImpl = (i: GoogleImpl) => { gg = i; };
export const setStripeImpl = (i: StripeImpl) => { st = i; };
export const setDiscordImpl = (i: DiscordImpl) => { dc = i; };
const proxy = <T extends object>(get: () => T) => new Proxy({} as T, { get: (_t, k) => (get() as Record<string | symbol, unknown>)[k] });
export const youtube = proxy(() => yt);
export const google = proxy(() => gg);
export const stripe = proxy(() => st);
export const discord = proxy(() => dc);
export const parseISODuration = (d: string) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d) ?? []; return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)); };
