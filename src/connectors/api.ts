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

/** Buckets de quota YouTube (doc officielle, juin 2026) : search.list et videos.insert ont leur propre quota. */
export type QuotaBucket = 'default' | 'search' | 'upload' | 'batchStats';
export interface QuotaState {
  day: string;                 // jour de quota (heure du Pacifique)
  resetAt: number;             // prochaine remise à zéro (ms epoch)
  reserve: number;             // unités du bucket général gardées pour les écritures (publication)
  buckets: { id: QuotaBucket; label: string; unit: string; used: number; limit: number }[];
  byMethod: Record<string, number>;
}

type YtImpl = {
  channels: () => Promise<YtChannel[]>;                                    // chaînes connectées (multi-comptes)
  /** Appel brut YouTube Data API v3 (GET/POST…) ; channelId => token OAuth de cette chaîne, sinon clé API.
   *  Les GET passent par le cache local (TTL par méthode ; cacheTtlSec: 0 = pas de cache, fresh: true = force l'actualisation). */
  data: <T = unknown>(path: string, params?: Record<string, string | number | boolean>, opts?: { channelId?: string; method?: string; body?: unknown; cacheTtlSec?: number; fresh?: boolean }) => Promise<T>;
  analytics: (q: AnalyticsQuery) => Promise<AnalyticsResult>;               // YouTube Analytics API v2 (reports.query)
  videos: (ids: string[]) => Promise<YtVideo[]>;                            // infos publiques
  channelVideos: (channelId: string, opts?: { max?: number; order?: 'date' | 'viewCount' }) => Promise<YtVideo[]>;
  /** type 'channel' : chaque résultat est une chaîne (id/channelId = id de chaîne, views = vues totales, durationSec = 0). */
  search: (q: string, opts?: { max?: number; order?: 'relevance' | 'viewCount' | 'date'; type?: 'video' | 'channel'; channelId?: string; regionCode?: string; relevanceLanguage?: string }) => Promise<YtVideo[]>;
  /** Jeton OAuth valide pour une chaîne (upload, analytics…). `scopes` : scopes supplémentaires à obtenir (consentement). */
  token: (channelId: string, scopes?: string[]) => Promise<string>;
  /** Unités consommées aujourd'hui dans le bucket général (10 000 / jour par défaut). */
  quotaUsedToday: () => Promise<number>;
  /** État détaillé de tous les buckets de quota. */
  quota: () => Promise<QuotaState>;
  /** À appeler par les modules qui parlent à YouTube hors `data` (upload resumable : 'videos.insert', 'thumbnails.set', 'captions.insert'…). */
  trackQuota: (method: string, calls?: number) => Promise<void>;
};
// ── Google (Gmail / Calendar / Drive) ────────────────────────
type GoogleImpl = {
  accounts: () => Promise<ConnectorAccount[]>;
  token: (accountId: string, scopes: string[]) => Promise<string>;          // ajoute les scopes si besoin (consentement)
  connect: (scopes: string[]) => Promise<ConnectorAccount>;
};
// ── Stripe / Discord ─────────────────────────────────────────
/** Instantané des revenus (montants en unités mineures — centimes — de `currency`). */
export interface RevenueSnapshot {
  at: number; currency: string; livemode: boolean;
  mrr: number | null;                                   // null si la clé n'a pas accès aux abonnements
  mrrByCurrency: Record<string, number>;
  activeSubscribers: number | null;
  today: { amount: number; count: number };
  todayByCurrency: Record<string, { amount: number; count: number }>;
  series: { date: string; amount: number; count: number }[]; // 30 derniers jours (date locale AAAA-MM-JJ)
  total30: number;
  warnings: string[];
}
type StripeImpl = {
  get: <T = unknown>(path: string, params?: Record<string, string | number>) => Promise<T>; connected: () => Promise<boolean>;
  /** MRR, ventes du jour, abonnés actifs, série 30 jours (cache 10 min, lecture hors-ligne). */
  revenue: (opts?: { force?: boolean }) => Promise<RevenueSnapshot>;
};
/** `send` demande confirmation (confirmAction) sauf si l'appelant l'a déjà fait : `confirmed: true`. */
type DiscordImpl = { send: (channelId: string, content: string, opts?: { embeds?: unknown[]; confirmed?: boolean }) => Promise<void>; channels: () => Promise<{ id: string; name: string; guild: string }[]> };

// ── Calendrier unifié (Google Agenda + dates des bases + publications programmées) ──
export interface CalendarItem {
  id: string; source: 'google' | 'prisme' | 'publication'; title: string;
  start: string; end: string; allDay: boolean;           // ISO 8601
  calendar: string; color: string;
  pageId?: string; accountId?: string; calendarId?: string; eventId?: string; htmlLink?: string; location?: string; description?: string;
}
type CalendarImpl = { events: (from: Date, to: Date) => Promise<CalendarItem[]> };

const nc = (s: string) => async (): Promise<never> => { throw new Error(`${s} n'est pas connecté — Réglages → Connexions.`); };
let yt: YtImpl = {
  channels: async () => [], data: nc('YouTube'), analytics: nc('YouTube'), videos: nc('YouTube'), channelVideos: nc('YouTube'), search: nc('YouTube'), token: nc('YouTube'), quotaUsedToday: async () => 0,
  quota: async () => ({ day: '', resetAt: 0, reserve: 0, buckets: [], byMethod: {} }), trackQuota: async () => undefined,
};
let gg: GoogleImpl = { accounts: async () => [], token: nc('Google'), connect: nc('Google') };
let st: StripeImpl = { get: nc('Stripe'), connected: async () => false, revenue: nc('Stripe') };
let dc: DiscordImpl = { send: nc('Discord'), channels: async () => [] };
let cal: CalendarImpl = { events: async () => [] };
export const setYoutubeImpl = (i: YtImpl) => { yt = i; };
export const setGoogleImpl = (i: GoogleImpl) => { gg = i; };
export const setStripeImpl = (i: StripeImpl) => { st = i; };
export const setDiscordImpl = (i: DiscordImpl) => { dc = i; };
export const setCalendarImpl = (i: CalendarImpl) => { cal = i; };
const proxy = <T extends object>(get: () => T) => new Proxy({} as T, { get: (_t, k) => (get() as Record<string | symbol, unknown>)[k] });
export const youtube = proxy(() => yt);
export const google = proxy(() => gg);
export const stripe = proxy(() => st);
export const discord = proxy(() => dc);
export const calendar = proxy(() => cal);

/** Durée ISO 8601 (« PT1H2M3S », « P1DT2H », « P1W »…) → secondes. Chaîne invalide → 0. */
export const parseISODuration = (d: string) => {
  const num = '(\\d+(?:[.,]\\d+)?)';
  const m = new RegExp(`^P(?:${num}Y)?(?:${num}M)?(?:${num}W)?(?:${num}D)?(?:T(?:${num}H)?(?:${num}M)?(?:${num}S)?)?$`, 'i').exec((d ?? '').trim());
  if (!m || /T$/i.test((d ?? '').trim())) return 0;
  const n = (i: number) => parseFloat((m[i] ?? '0').replace(',', '.'));
  return Math.round(n(1) * 31_536_000 + n(2) * 2_592_000 + n(3) * 604_800 + n(4) * 86_400 + n(5) * 3600 + n(6) * 60 + n(7));
};

// ── Scopes OAuth fournis aux autres modules ──────────────────
/** Scopes Google par service. Gmail (module mail) : `google.token(accountId, GOOGLE_SCOPES.gmail)` déclenche le consentement si besoin. */
export const GOOGLE_SCOPES = {
  identity: ['openid', 'email', 'profile'],
  gmail: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'],
  calendar: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
};
/** Scopes YouTube : la connexion d'une chaîne demande readonly + analytics (obligatoires) et manage/upload/monetary (facultatifs). */
export const YOUTUBE_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/youtube.readonly',
  manage: 'https://www.googleapis.com/auth/youtube.force-ssl',
  upload: 'https://www.googleapis.com/auth/youtube.upload',
  analytics: 'https://www.googleapis.com/auth/yt-analytics.readonly',
  monetary: 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
};
// Point d'entrée du module connectors : src/connectors/index.ts.
export {};
