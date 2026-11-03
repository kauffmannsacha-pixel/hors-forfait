// Découpage horodaté (pur, testé) : fenêtres de ~60-90 s qui gardent leurs segments
// (pour retrouver l'horodatage EXACT du segment où un conseil est formulé).
import type { TranscriptSegment } from '../api';

export interface TranscriptWindow { index: number; start: number; end: number; text: string; segments: TranscriptSegment[] }
export interface ChunkOptions { min?: number; max?: number; target?: number }

const endOf = (s: TranscriptSegment) => s.start + Math.max(0, s.dur || 0);
const SENTENCE_END = /[.!?…]["»”')\]]?$/;

function makeWindow(segs: TranscriptSegment[]): TranscriptWindow {
  const last = segs[segs.length - 1];
  return {
    index: 0,
    start: segs[0].start,
    end: Math.max(endOf(last), last.start),
    text: segs.map(s => s.text.trim()).filter(Boolean).join(' '),
    segments: segs,
  };
}

/**
 * Regroupe les segments en fenêtres : on coupe dès `target` secondes, ou dès `min` secondes sur une fin de phrase,
 * sans jamais dépasser `max` (sauf segment isolé plus long). Une dernière fenêtre trop courte est fusionnée.
 */
export function chunkTranscript(segments: TranscriptSegment[], opts: ChunkOptions = {}): TranscriptWindow[] {
  const min = opts.min ?? 60, max = opts.max ?? 90, target = Math.min(Math.max(opts.target ?? 75, min), max);
  const segs = segments.filter(s => s.text && s.text.trim() && isFinite(s.start)).slice().sort((a, b) => a.start - b.start);
  const out: TranscriptWindow[] = [];
  let cur: TranscriptSegment[] = [];
  const flush = () => { if (cur.length) { out.push(makeWindow(cur)); cur = []; } };
  for (const s of segs) {
    if (cur.length && endOf(s) - cur[0].start > max) flush();
    cur.push(s);
    const span = endOf(s) - cur[0].start;
    if (span >= target || (span >= min && SENTENCE_END.test(s.text.trim()))) flush();
  }
  flush();
  if (out.length >= 2) {
    const last = out[out.length - 1], prev = out[out.length - 2];
    if (last.end - last.start < min / 2 && last.end - prev.start <= max + min / 2) {
      out.splice(out.length - 2, 2, makeWindow([...prev.segments, ...last.segments]));
    }
  }
  return out.map((w, i) => ({ ...w, index: i }));
}

/** Coupe une transcription à `maxSeconds` (coût d'analyse maîtrisé sur les vidéos très longues). */
export const truncateSegments = (segs: TranscriptSegment[], maxSeconds: number) =>
  maxSeconds > 0 ? segs.filter(s => s.start < maxSeconds) : segs;

/** Segment dont le début est le plus proche de t (dans une liste donnée). */
export function nearestSegmentStart(segs: TranscriptSegment[], t: number): number | null {
  let best: number | null = null; let bestD = Infinity;
  for (const s of segs) { const d = Math.abs(s.start - t); if (d < bestD) { bestD = d; best = s.start; } }
  return best;
}
