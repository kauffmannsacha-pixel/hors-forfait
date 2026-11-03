// Types du miniatureur (stockés en kv : garder les champs rétro-compatibles).
import type { ImageMetrics } from './metrics';

export const EMOTIONS = ['joie', 'surprise', 'peur', 'colère', 'tristesse', 'dégoût', 'curiosité', 'détermination', 'neutre', 'aucune'] as const;
export type Emotion = typeof EMOTIONS[number];
export const LAYOUTS = ['centrée', 'tiers', 'split', 'avant-après', 'gros plan', 'plan large', 'autre'] as const;
export type Layout = typeof LAYOUTS[number];

/** Analyse Claude Vision d'une miniature. */
export interface VisionAnalysis {
  face: boolean; faceCount: number;
  emotion: Emotion; emotionIntensity: number;          // 0..10
  elements: string[]; elementCount: number;
  hasText: boolean; text: string; wordCount: number;
  focalPoint: { x: number; y: number; description: string };
  composition: string; layout: Layout;
  background: string; colorStrategy: string;
  curiosity: string;
  whyItWorks: string[];
  weaknesses: string[];
  citations: string[];                                  // principes sourcés cités (formatCitation)
}

/** Miniature d'une vidéo analysée (mur d'inspiration). */
export interface ThumbRecord {
  videoId: string; title: string; channelId: string; channelTitle: string; publishedAt: string;
  durationSec: number; views: number; likes?: number;
  subscribers?: number;          // abonnés de la chaîne (si publics)
  ratio?: number;                // vues / abonnés
  niche: string;                 // étiquette principale (requête normalisée ou nom de chaîne)
  niches?: string[];             // toutes les niches où la vidéo est apparue
  source: { kind: 'niche' | 'chaine'; query: string };
  imageUrl: string;              // URL utilisée (maxresdefault ou repli)
  metrics?: ImageMetrics; metricsError?: string;
  vision?: VisionAnalysis; visionError?: string;
  analyzedAt: number;
}

export interface RefEntry { videoId: string; addedAt: number; note?: string; fileHash?: string }

/** Une version de miniature pour une vidéo (test A/B). kv 'thumb:versions:<videoId>' */
export interface ThumbVersion {
  id: string; hash: string; name: string; createdAt: number;
  source: 'import' | 'editeur' | 'generee' | 'vault';
  score?: number; note?: string;
}
export interface VersionIndexEntry { videoId: string; title: string; updatedAt: number }

/** Critique Vision de MA miniature. */
export interface CritiqueProblem { issue: string; fix: string; severity: 'haute' | 'moyenne' | 'basse'; citations: string[] }
export interface MyCritique {
  score: number; verdict: string;
  face: boolean; emotion: Emotion; text: string; wordCount: number; elementCount: number;
  focalPoint: { x: number; y: number; description: string };
  strengths: string[]; problems: CritiqueProblem[]; quickWins: string[];
  titleSynergy: string; smallSize: string;
  citations: string[];
}
export interface MyAnalysis {
  id: string; at: number; name: string; hash?: string;
  title?: string; niche?: string;
  metrics?: ImageMetrics; critique?: MyCritique; critiqueError?: string;
  score: number;                 // /10 final (Vision + mesures)
  reasons: string[];
  citations: string[];
}

/** Concept de composition (générateur). */
export interface SketchItem {
  kind: 'visage' | 'personne' | 'objet' | 'texte' | 'fleche' | 'cercle' | 'fond' | 'split' | 'halo';
  x: number; y: number; w: number; h: number;           // 0..1, origine en haut à gauche
  label?: string; color?: string; emotion?: Emotion;
}
export interface Concept {
  id: string; name: string; idea: string;
  shot: string; subject: string; expression: string;
  elements: string[]; colors: string[]; background: string;
  text: string; textColor: string; textStroke: string; textPosition: string; textTooLong?: boolean;
  focal: string; titleSynergy: string; why: string;
  sketch: SketchItem[]; imagePrompt: string; citations: string[];
}
export interface Brief { subject: string; emotion: Emotion | ''; title: string; niche: string; constraints: string; count: number; useRefs: boolean }
export interface ConceptBatch { id: string; at: number; brief: Brief; concepts: Concept[] }
