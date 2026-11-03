// ─────────────────────────────────────────────────────────────
// CONTRAT Base de connaissances — implémenté par le module knowledge.
// Les assistants appellent searchPrinciples() et citent formatCitation().
// ─────────────────────────────────────────────────────────────
export type Topic = 'script' | 'retention' | 'hook' | 'thumbnail' | 'title' | 'packaging' | 'analytics' | 'general';
export interface Source { creator: string; videoId?: string; videoTitle?: string; url?: string; timestamp?: number /* secondes */; kind: 'youtube' | 'document' | 'ab-test' | 'manual' }
export interface Principle { id: string; topic: Topic; title: string; text: string; source: Source; score?: number }

type Impl = {
  search: (query: string, opts?: { topic?: Topic; k?: number }) => Promise<Principle[]>;
  add: (p: Omit<Principle, 'id'>) => Promise<Principle>;
};
let impl: Impl = { search: async () => [], add: async (p) => ({ ...p, id: crypto.randomUUID() }) };
export const setKnowledgeImpl = (i: Impl) => { impl = i; };

export const searchPrinciples = (query: string, opts?: { topic?: Topic; k?: number }) => impl.search(query, opts);
export const addPrinciple = (p: Omit<Principle, 'id'>) => impl.add(p);

export const fmtTime = (s?: number) => s == null ? '' : `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
/** « Principe : hook en < 5 s — source : Paddy Galloway, 03:42 » */
export const formatCitation = (p: Principle) =>
  `Principe : ${p.title} — source : ${p.source.creator}${p.source.timestamp != null ? ', ' + fmtTime(p.source.timestamp) : ''}`;
/** Bloc de contexte à injecter dans un prompt système (principes numérotés, à citer par [n]). */
export const principlesToPrompt = (ps: Principle[]) =>
  ps.map((p, i) => `[${i + 1}] ${p.title} : ${p.text} (source : ${p.source.creator}${p.source.timestamp != null ? ', ' + fmtTime(p.source.timestamp) : ''})`).join('\n');

// ── Transcriptions (fournisseurs : sous-titres YouTube officiels de MES vidéos, outil MCP « transcript », import manuel) ──
export interface TranscriptSegment { start: number; dur: number; text: string }
export interface Transcript { videoId: string; language?: string; provider: 'youtube-captions' | 'mcp' | 'manual'; segments: TranscriptSegment[]; /** false = horodatages estimés (texte brut sans temps) : ne pas les citer. */ timed?: boolean }
let transcriptImpl: (videoIdOrUrl: string) => Promise<Transcript> = async () => { throw new Error('Aucune source de transcription configurée.'); };
export const setTranscriptImpl = (f: typeof transcriptImpl) => { transcriptImpl = f; };
export const getTranscript = (videoIdOrUrl: string) => transcriptImpl(videoIdOrUrl);
export const parseVideoId = (s: string) => (/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(s)?.[1]) ?? (/^[\w-]{11}$/.test(s) ? s : null);

// ── Ajouts du module knowledge (ajout seulement) ─────────────
export const TOPICS: Topic[] = ['script', 'retention', 'hook', 'thumbnail', 'title', 'packaging', 'analytics', 'general'];
export const TOPIC_LABELS: Record<Topic, string> = { script: 'Script', retention: 'Rétention', hook: 'Hook', thumbnail: 'Miniatures', title: 'Titres', packaging: 'Packaging', analytics: 'Analytics', general: 'Général' };
/** URL de la source : vidéo YouTube horodatée (…watch?v=ID&t=SECONDES) ou lien du document. */
export const sourceUrl = (s: Source): string | undefined =>
  s.videoId ? `https://www.youtube.com/watch?v=${s.videoId}${s.timestamp != null ? `&t=${Math.max(0, Math.floor(s.timestamp))}` : ''}` : s.url;
/** Ouvre la source dans le navigateur par défaut (plugin opener dans l'app). */
export async function openSourceUrl(s: Source): Promise<void> {
  const url = sourceUrl(s);
  if (!url) throw new Error('Cette source n\'a pas de lien.');
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}
