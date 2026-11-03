// Types internes du module knowledge (le contrat public est dans ./api.ts).
import type { Principle, Source, Topic, Transcript } from './api';

/** D'où vient un principe stocké. */
export type Origin = 'seed' | 'ingest' | 'document' | 'manual' | 'ab-test';

/** Principe tel que stocké (contrat + métadonnées internes). */
export interface KnPrinciple extends Principle {
  origin: Origin;
  /** Identifiant de la source ingérée (kn_sources.id), ex. « yt:VIDEOID » ou « doc:UUID ». */
  sourceId?: string;
  /** Empreinte normalisée titre+texte (dédoublonnage exact). */
  hash: string;
  createdAt: number;
}

export type SourceStatus = 'ok' | 'empty' | 'no-transcript' | 'error';

/** Vidéo ou document ingéré. */
export interface KnSource {
  id: string;
  kind: Source['kind'];
  creator: string;
  videoId?: string;
  title?: string;
  url?: string;
  channelId?: string;
  channelTitle?: string;
  status: SourceStatus;
  detail?: string;
  provider?: Transcript['provider'];
  principles: number;
  durationSec?: number;
  views?: number;
  publishedAt?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** Créateur suivi (réglages). */
export interface CreatorConfig {
  id: string;
  name: string;
  /** @handle YouTube (résolu via channels.list?forHandle, 1 unité de quota). */
  handle?: string;
  channelId?: string;
  resolvedTitle?: string;
  thumbnail?: string;
  enabled: boolean;
}

/** Requête de recherche par sujet (réglages). */
export interface TopicQuery { id: string; topic: Topic; query: string; enabled: boolean }

export interface KnSettings {
  autoUpdate: boolean;
  creators: CreatorConfig[];
  queries: TopicQuery[];
  /** Nombre max de vidéos transcrites + analysées par mise à jour. */
  maxVideosPerUpdate: number;
  /** Vidéos récentes examinées par créateur. */
  videosPerCreator: number;
  /** Résultats demandés par requête de recherche. */
  resultsPerQuery: number;
  /** Budget de quota YouTube (unités) par mise à jour. */
  quotaBudget: number;
  /** Quota quotidien du projet Google Cloud (10 000 par défaut). */
  dailyQuota: number;
  minViews: number;
  minDurationSec: number;
  /** Au-delà, la transcription est tronquée (coût Claude maîtrisé). */
  maxMinutesPerVideo: number;
  /** Ne garder que les vidéos des créateurs suivis dans les recherches par sujet. */
  onlyFollowed: boolean;
  /** Recherche sémantique (embeddings locaux). */
  semantic: boolean;
  model: string;
}

/** Vidéo en file d'attente du pré-remplissage (IDs vérifiés). */
export interface SeedVideo {
  videoId: string;
  title: string;
  creator: string;
  channelTitle?: string;
  channelId?: string;
  durationSec?: number;
  views?: number;
  topics?: Topic[];
}

export interface SeedPrinciple { id: string; topic: Topic; title: string; text: string; source: Source }

export interface SeedFile {
  version: number;
  generatedAt: string;
  note?: string;
  principles: SeedPrinciple[];
  videos: SeedVideo[];
}

/** Métadonnées d'une vidéo à ingérer. */
export interface VideoMeta {
  videoId: string;
  title: string;
  creator: string;
  channelId?: string;
  channelTitle?: string;
  durationSec?: number;
  views?: number;
  publishedAt?: string;
  /** Priorité (plus grand = traité d'abord). */
  priority: number;
  origin: 'queue' | 'creator' | 'search' | 'manual';
}

export interface UpdateReport {
  startedAt: number;
  finishedAt: number;
  auto: boolean;
  cancelled: boolean;
  videos: number;
  principles: number;
  duplicates: number;
  noTranscript: number;
  errors: number;
  quotaUsed: number;
  messages: string[];
}
