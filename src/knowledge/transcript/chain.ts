// Chaînage des fournisseurs de transcription (pur, testé) : cache → fournisseurs dans l'ordre → erreur explicite.
import { parseVideoId, type Transcript } from '../api';

export interface TranscriptContext {
  /** Chaîne de la vidéo si déjà connue (évite un appel videos.list). */
  channelId?: string;
  signal?: AbortSignal;
  /** Appelé avant chaque appel YouTube coûteux (garde de quota) ; peut lever une erreur. */
  beforeCall?: (cost: number, label: string) => Promise<void> | void;
  /** Ignore le cache (nouvelle récupération). */
  refresh?: boolean;
}

export interface TranscriptProvider {
  id: Transcript['provider'];
  label: string;
  /** null = ne s'applique pas / rien trouvé ; exception = échec (raison rapportée). */
  fetch: (videoId: string, ctx: TranscriptContext) => Promise<Transcript | null>;
}

export interface TranscriptCache {
  get: (videoId: string) => Promise<Transcript | undefined>;
  set: (t: Transcript) => Promise<void>;
}

export class TranscriptUnavailableError extends Error {
  constructor(public videoId: string, public reasons: string[]) {
    super(`Aucune transcription disponible pour la vidéo ${videoId}${reasons.length ? ' (' + reasons.join(' · ') + ')' : ''}. ` +
      'Importe-la à la main (.srt, .vtt, .txt ou texte collé) dans Base de connaissances → Importer.');
    this.name = 'TranscriptUnavailableError';
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Crée la fonction getTranscript : cache d'abord, puis chaque fournisseur dans l'ordre ; le premier résultat non vide gagne. */
export function createTranscriptChain(providers: TranscriptProvider[], cache?: TranscriptCache) {
  return async (videoIdOrUrl: string, ctx: TranscriptContext = {}): Promise<Transcript> => {
    const videoId = parseVideoId(videoIdOrUrl.trim());
    if (!videoId) throw new Error('Lien ou identifiant de vidéo YouTube invalide.');
    if (cache && !ctx.refresh) {
      const hit = await cache.get(videoId).catch(() => undefined);
      if (hit && hit.segments.length) return hit;
    }
    const reasons: string[] = [];
    for (const p of providers) {
      if (ctx.signal?.aborted) throw new DOMException('Annulé', 'AbortError');
      try {
        const t = await p.fetch(videoId, ctx);
        if (t && t.segments.length) {
          const out: Transcript = { ...t, videoId };
          if (cache) await cache.set(out).catch(() => undefined);
          return out;
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        reasons.push(`${p.label} : ${msg(e)}`);
      }
    }
    throw new TranscriptUnavailableError(videoId, reasons);
  };
}
