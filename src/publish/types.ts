// Types du module Publication (file d'envoi, brouillons, tests A/B, historique).
// Clés kv : 'publish:queue', 'publish:draft', 'publish:history', 'publish:templates', 'publish:links', 'abtests'.

export type Privacy = 'private' | 'unlisted' | 'public';
export type License = 'youtube' | 'creativeCommon';

export interface Chapter { start: number /* secondes */; title: string }

export interface DraftFile {
  path: string; name: string; size: number; mime?: string;
  durationSec?: number | null; width?: number | null; height?: number | null;
  vaultHash?: string;
}
export interface DraftImage { path: string; name: string; hash?: string; mime?: string; size?: number }
export interface CaptionTrack { id: string; path: string; fileName: string; language: string; name: string; isDraft: boolean }
export interface LinkItem { label: string; url: string }

/** Variante prévue pour un test A/B lancé à la publication. */
export interface PlannedVariant { id: string; title: string; thumbnail?: DraftImage }
export interface PlannedAbTest { variants: PlannedVariant[]; intervalHours: number; autoApply: boolean; threshold: number }

export interface VideoDraft {
  id: string;
  channelId: string;
  file?: DraftFile;
  title: string;
  /** Texte de description, peut contenir des variables {{chapitres}}, {{liens}}… */
  description: string;
  templateId?: string;
  includeChapters: boolean;
  includeLinks: boolean;
  chapters: Chapter[];
  tags: string[];
  categoryId: string;
  defaultLanguage: string;
  defaultAudioLanguage: string;
  thumbnail?: DraftImage;
  captions: CaptionTrack[];
  playlistIds: string[];
  privacy: Privacy;
  /** ISO 8601 UTC si la vidéo est programmée (impose privacyStatus = private). */
  scheduleAt?: string;
  /** null = non déclaré (bloquant). */
  madeForKids: boolean | null;
  containsSyntheticMedia: boolean;
  license: License;
  embeddable: boolean;
  publicStatsViewable: boolean;
  notifySubscribers: boolean;
  /** AAAA-MM-JJ */
  recordingDate?: string;
  ideaRowId?: string;
  scriptPageId?: string;
  abTest?: PlannedAbTest;
  updatedAt: number;
}

export type QueueState = 'attente' | 'envoi' | 'pause' | 'finalisation' | 'termine' | 'erreur';
export type StepKind = 'thumbnail' | 'caption' | 'playlist' | 'kanban' | 'abtest';
export interface PostStep { id: string; kind: StepKind; label: string; ref?: string; state: 'todo' | 'ok' | 'error'; error?: string; attempts?: number }

export interface QueueItem {
  id: string;
  draft: VideoDraft;
  /** Description finale (variables résolues) envoyée à YouTube. */
  description: string;
  channelTitle: string;
  state: QueueState;
  createdAt: number;
  confirmedAt?: number;
  uploadUrl?: string;
  sessionAt?: number;
  total: number;
  offset: number;
  videoId?: string;
  error?: string;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  steps: PostStep[];
  /** Checklist manuelle (écran de fin, fiches…) — non disponible via l'API. */
  manual: Record<string, boolean>;
  uploadStatus?: string;
}

export interface LiveStats { bytesPerSec: number; etaSec: number | null; sent: number; updatedAt: number; phase?: string }

/** Vidéo publiée via Prisme (alimente le calendrier du Studio et les instantanés de stats). */
export interface PublishedVideo {
  videoId: string; channelId: string; channelTitle: string; title: string;
  privacy: Privacy; scheduleAt?: string; publishedAt: number; url: string;
  ideaRowId?: string; thumbnailHash?: string; thumbnailPath?: string;
}

// ── Tests A/B (kv 'abtests') ─────────────────────────────────
export interface AbPeriod {
  start: number; end?: number;
  impressions?: number; ctr?: number /* 0..1 */; views?: number; avgViewDuration?: number /* s */; days?: number;
}
export interface AbVariant { id: string; label: string; title: string; thumbnailHash?: string; thumbnailPath?: string; periods: AbPeriod[] }
export interface AbDaily { date: string /* AAAA-MM-JJ, heure du Pacifique */; views: number; avgViewDuration?: number; impressions?: number; ctr?: number }
/** `index` et `thumbnailHash` sont lus par l'assistant Miniatures (lecture seule de kv 'abtests'). */
export interface AbWinner { index: number; variantId: string; thumbnailHash?: string; title?: string; confidence: number; metric: 'ctr' | 'views'; decidedAt: number; applied: boolean; lift: number }
export interface AbTest {
  id: string;
  videoId: string; channelId: string; channelTitle: string; videoTitle: string;
  variants: AbVariant[];
  winner?: AbWinner;
  status: 'planifie' | 'actif' | 'termine' | 'arrete';
  intervalHours: number;
  autoApply: boolean;
  threshold: number;          // confiance requise (0.9 / 0.95 / 0.99)
  minImpressions: number;     // par variante (CTR)
  minDaysPerVariant: number;  // jours complets par variante
  current: number;            // index de la variante en ligne
  startAt: number;
  lastRotationAt?: number;
  nextRotationAt?: number;
  createdAt: number;
  endedAt?: number;
  originalTitle: string;
  originalThumbnailUrl?: string;
  daily?: AbDaily[];
  lastMetricsAt?: number;
  metricsNote?: string;
  lessonAdded?: boolean;
  log: { at: number; text: string; kind?: 'info' | 'error' }[];
}
