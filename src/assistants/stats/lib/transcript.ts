// Alignement transcription ↔ temps : segments de sous-titres → phrases horodatées,
// recherche de la phrase prononcée à un instant donné, et perte d'audience pendant chaque phrase.
import type { TranscriptSegment } from '../../../knowledge/api';

export interface Sentence { index: number; start: number; end: number; text: string }
export interface SentenceStat extends Sentence {
  /** Rétention au début / à la fin de la phrase. */
  r0: number;
  r1: number;
  /** Variation pendant la phrase, en points. */
  deltaPts: number;
  /** Variation ramenée à 10 s (points / 10 s) : comparable entre phrases de longueurs différentes. */
  ratePer10s: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };

/** Décode les entités HTML, retire les balises (<c>, <i>…) et les marqueurs « >> » des sous-titres. */
export function cleanCaptionText(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]*>/g, ' ')
    .replace(/(^|\s)>>+\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trie, nettoie, fusionne les segments de même départ et supprime les chevauchements (sous-titres « déroulants »). */
export function normalizeSegments(segs: TranscriptSegment[], durationSec?: number): TranscriptSegment[] {
  const clean = segs
    .map(x => ({ start: Math.max(0, Number(x.start) || 0), dur: Math.max(0, Number(x.dur) || 0), text: cleanCaptionText(String(x.text ?? '')) }))
    .filter(x => x.text.length > 0)
    .sort((a, b) => a.start - b.start);
  const merged: TranscriptSegment[] = [];
  for (const s of clean) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.start - s.start) < 1e-3) { last.text += ' ' + s.text; last.dur = Math.max(last.dur, s.dur); }
    else merged.push({ ...s });
  }
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i], next = merged[i + 1];
    let end = s.start + (s.dur > 0 ? s.dur : 2);
    if (next && end > next.start) end = next.start;
    if (durationSec != null && durationSec > 0) end = Math.min(end, durationSec);
    s.dur = Math.max(0.05, end - s.start);
  }
  return merged;
}

interface Token { w: string; t0: number; t1: number; seg: number }
/** Découpe chaque segment en mots, horodatés proportionnellement à leur longueur. */
export function tokenize(segs: TranscriptSegment[]): Token[] {
  const out: Token[] = [];
  segs.forEach((s, seg) => {
    const words = s.text.split(' ').filter(Boolean);
    const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
    let t = s.start;
    for (const w of words) {
      const d = (s.dur * (w.length + 1)) / total;
      out.push({ w, t0: t, t1: t + d, seg });
      t += d;
    }
  });
  return out;
}

/** Transcription ponctuée (sous-titres manuels/IA) ou brute (sous-titres auto) ? */
export function isPunctuated(segs: TranscriptSegment[]): boolean {
  const text = segs.map(s => s.text).join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  const enders = (text.match(/[.!?…]+["»”’')\]]*(?=\s|$)/g) ?? []).length;
  return words > 0 && enders >= Math.max(2, words / 60);
}

const ABBREV = new Set(['m.', 'mme.', 'mlle.', 'mm.', 'dr.', 'pr.', 'st.', 'ste.', 'mr.', 'mrs.', 'ms.', 'vs.', 'ex.', 'p.', 'cf.', 'n°.', 'no.', 'env.', 'etc.,']);
const isAbbrev = (w: string) => ABBREV.has(w.toLowerCase()) || /^[A-Z]\.$/.test(w);
const endsSentence = (w: string) => /[.!?…]["»”’')\]]*$/.test(w) && !isAbbrev(w);
const ellipsis = (w: string) => /(\.\.\.|…)["»”’')\]]*$/.test(w);

export interface SentenceOptions {
  /** Durée max d'une phrase avant coupure forcée (s). */
  maxDur?: number;
  maxChars?: number;
  /** Silence qui force une coupure (s). */
  pauseSec?: number;
}

/**
 * Regroupe les segments en phrases horodatées.
 * Ponctuée : coupe sur . ! ? … (sauf abréviations / points de suspension suivis d'une minuscule).
 * Brute : coupe sur les silences et aux frontières de segment dès ~3,5 s.
 */
export function buildSentences(segments: TranscriptSegment[], opts: SentenceOptions = {}): Sentence[] {
  const segs = normalizeSegments(segments);
  if (!segs.length) return [];
  const punct = isPunctuated(segs);
  const maxDur = opts.maxDur ?? (punct ? 20 : 7);
  const maxChars = opts.maxChars ?? (punct ? 260 : 120);
  const pause = opts.pauseSec ?? (punct ? 1.5 : 0.6);
  const toks = tokenize(segs);
  const out: Sentence[] = [];
  let cur: Token[] = [];
  let chars = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({ index: out.length, start: cur[0].t0, end: cur[cur.length - 1].t1, text: cur.map(t => t.w).join(' ') });
    cur = []; chars = 0;
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i], next = toks[i + 1];
    cur.push(tk); chars += tk.w.length + 1;
    if (!next) break;
    const gap = next.t0 - tk.t1;
    const dur = next.t1 - cur[0].t0;
    const boundary = next.seg !== tk.seg;
    if (gap >= pause) { flush(); continue; }
    if (punct) {
      if (endsSentence(tk.w) && !(ellipsis(tk.w) && /^[a-zà-ÿ]/.test(next.w))) { flush(); continue; }
      if ((dur > maxDur || chars > maxChars) && (boundary || chars > maxChars * 1.5)) { flush(); continue; }
    } else if (boundary && (tk.t1 - cur[0].t0 >= 3.5 || dur > maxDur || chars > maxChars)) {
      flush();
      continue;
    }
  }
  flush();
  return out;
}

/** Phrase prononcée à l'instant t (tolérance : la phrase qui vient de se terminer reste affichée pendant un court silence). */
export function sentenceAt(sentences: Sentence[], t: number, tolerance = 1): Sentence | null {
  if (!sentences.length) return null;
  let lo = 0, hi = sentences.length - 1;
  if (t < sentences[0].start) return sentences[0].start - t <= tolerance ? sentences[0] : null;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sentences[mid].start <= t) lo = mid; else hi = mid - 1; }
  const s = sentences[lo];
  if (t <= s.end) return s;
  const next = sentences[lo + 1];
  if (t - s.end <= tolerance && (!next || next.start - t > t - s.end)) return s;
  if (next && next.start - t <= tolerance) return next;
  return null;
}

/** Index approximatif du mot prononcé à l'instant t dans la phrase (répartition proportionnelle à la longueur des mots). */
export function wordIndexAt(sentence: Sentence, t: number): number {
  const words = sentence.text.split(' ');
  const span = sentence.end - sentence.start;
  if (span <= 0 || words.length <= 1) return 0;
  const f = Math.min(1, Math.max(0, (t - sentence.start) / span));
  const total = words.reduce((n, w) => n + w.length + 1, 0);
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    acc += words[i].length + 1;
    if (acc / total >= f - 1e-9) return i;
  }
  return words.length - 1;
}

/** Rétention au début / à la fin de chaque phrase (valueAt = lecture de la courbe interpolée). */
export function sentenceStats(sentences: Sentence[], valueAt: (t: number) => number): SentenceStat[] {
  return sentences.map(s => {
    const r0 = valueAt(s.start), r1 = valueAt(s.end);
    const deltaPts = (r1 - r0) * 100;
    return { ...s, r0, r1, deltaPts, ratePer10s: (deltaPts / Math.max(1, s.end - s.start)) * 10 };
  });
}

/** Phrases qui font le plus décrocher (perte par 10 s), hors intro si demandé. */
export function worstSentences(stats: SentenceStat[], n = 8, opts: { after?: number; minDur?: number } = {}): SentenceStat[] {
  const minDur = opts.minDur ?? 1.5;
  return stats
    .filter(s => s.end - s.start >= minDur && s.start >= (opts.after ?? 0) && s.deltaPts < 0)
    .sort((a, b) => a.ratePer10s - b.ratePer10s)
    .slice(0, n);
}

/** Texte de la transcription entre deux instants. */
export function textBetween(sentences: Sentence[], from: number, to: number): string {
  return sentences.filter(s => s.end > from && s.start < to).map(s => s.text).join(' ');
}
