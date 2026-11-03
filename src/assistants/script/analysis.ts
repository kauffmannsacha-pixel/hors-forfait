// Mode « Analyser un script » : découpage d'une transcription en blocs horodatés,
// pré-annotation locale des techniques, frise colorée, lecture du flux JSONL de Claude.
import type { TranscriptSegment } from '../../knowledge/api';
import { flagsOf, normalizeForMatch, words } from './patterns';
import { splitSentences } from './heuristics';
import { TECHNIQUES, techniqueDef, type TechniqueKind } from './method';

export interface TBlock { i: number; start: number; end: number; text: string }
export interface Annotation { i: number; kind: TechniqueKind; why: string; quote?: string; source: 'local' | 'claude' }
export interface AnalysisSummary { structure: string; hook: string; lecons: string[]; techniquesCles: string[] }
export interface VideoAnalysis {
  id: string; videoId: string; title: string; channel?: string; views?: number; durationSec: number; createdAt: number;
  timed: boolean; language?: string; provider?: string;
  blocks: TBlock[]; annotations: Annotation[]; summary?: AnalysisSummary; status: 'local' | 'partial' | 'complete';
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
export const decodeEntities = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENTITIES[m] ?? m).replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
const cleanCaption = (s: string) => decodeEntities(s).replace(/\[(?:musique|music|applaudissements|applause|rires|laughter|♪+)\]/gi, ' ').replace(/♪/g, ' ').replace(/\s+/g, ' ').trim();

/** Regroupe les segments de sous-titres en blocs de ~20 s (plus fins sur les 30 premières secondes, zone du hook). */
export function segmentTranscript(segs: TranscriptSegment[], opts: { target?: number; max?: number; hookTarget?: number } = {}): TBlock[] {
  const target = opts.target ?? 22, max = opts.max ?? 38, hookTarget = opts.hookTarget ?? 8;
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: TBlock[] = [];
  let cur: { start: number; end: number; parts: string[] } | null = null;
  const close = () => { if (cur && cur.parts.length) out.push({ i: out.length, start: cur.start, end: cur.end, text: cur.parts.join(' ').replace(/\s+/g, ' ').trim() }); cur = null; };
  for (let k = 0; k < sorted.length; k++) {
    const sg = sorted[k];
    const text = cleanCaption(sg.text);
    if (!text) continue;
    const segEnd = sg.start + Math.max(0, sg.dur || 0);
    if (!cur) cur = { start: sg.start, end: segEnd, parts: [] };
    const c: { start: number; end: number; parts: string[] } = cur;
    c.parts.push(text);
    c.end = Math.max(c.end, segEnd, sg.start);
    const len = c.end - c.start;
    const tgt = c.start < 30 ? hookTarget : target;
    const next = sorted[k + 1];
    const gap = next ? next.start - segEnd : Infinity;
    const sentenceEnd = /[.!?…]["»”']?$/.test(text);
    if (len >= max || (len >= tgt && (sentenceEnd || gap > 1 || !next)) || len >= tgt * 1.5) close();
  }
  close();
  // Fin d'un bloc = début du suivant (pas de trous dans la frise)
  for (let i = 0; i + 1 < out.length; i++) out[i].end = Math.max(out[i].end, out[i + 1].start);
  return out;
}

const TEASER = [words('bien plus encore', 'on commence par', 'and (?:so )?much more', "let'?s start with", 'pour (?:commencer|l\'instant)')];
const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Pré-annotation instantanée (motifs de la méthode) en attendant l'analyse de Claude. */
export function detectTechniquesLocal(blocks: TBlock[]): Annotation[] {
  const out: Annotation[] = [];
  const total = blocks.length ? blocks[blocks.length - 1].end : 0;
  for (const b of blocks) {
    const seen = new Set<TechniqueKind>();
    const add = (kind: TechniqueKind, why: string, quote?: string) => { if (seen.has(kind)) return; seen.add(kind); out.push({ i: b.i, kind, why, quote: quote ? clip(quote) : undefined, source: 'local' }); };
    if (b.i === 0 || b.start < 5) add('hook', 'Ouverture : ces premières secondes doivent arrêter le scroll et confirmer la miniature.');
    const sentences = splitSentences(b.text).map(r => b.text.slice(r.s, r.e));
    for (const s of sentences) {
      const f = flagsOf(s);
      const n = normalizeForMatch(s);
      if (TEASER.some(r => r.test(n))) add('teaser', 'Annonce de ce qui arrive (teaser du sommaire).', s);
      if (f.objective && b.start < 75) add('promesse', 'Objectif / enjeux annoncés tôt.', s);
      if (f.setup) add('setup', 'Élément planté pour plus tard (« retenez bien ça »).', s);
      if (f.openLoop) add('boucle', 'Boucle ouverte annoncée à voix haute.', s);
      if (f.question && !f.openLoop) add(b.start > 45 ? 'rehook' : 'boucle', b.start > 45 ? 'Question qui relance l\'attention.' : 'Question laissée en suspens.', s);
      if (f.twist) add('obstacle', 'Obstacle / rebondissement : crée une mini-boucle.', s);
      if (f.escalation) add('escalade', 'Passage à un palier supérieur.', s);
      if (f.callback || f.close) add('fermeture', 'Retour sur un fil ouvert plus tôt.', s);
      if (f.interrupt) add('interrupt', 'Pattern interrupt (blague, aparté).', s);
      if (f.sponsor) add('sponsor', 'Passage sponsor.', s);
      if (f.payoff && b.start >= total * 0.7) add('payoff', 'Livraison de la promesse.', s);
      if ((f.ctaEarly || f.recap) && b.start >= total * 0.85) add('cta', 'Sortie / appel à l\'action.', s);
    }
  }
  return out;
}

const PRIORITY: TechniqueKind[] = ['hook', 'payoff', 'obstacle', 'escalade', 'rehook', 'boucle', 'setup', 'teaser', 'promesse', 'fermeture', 'interrupt', 'sponsor', 'cta'];
export interface TimelineSeg { i: number; start: number; end: number; left: number; width: number; color: string; kinds: TechniqueKind[]; primary: TechniqueKind | null }
/** Segments de la frise colorée (position en % de la durée). */
export function timelineSegments(blocks: TBlock[], annotations: Annotation[], duration?: number): TimelineSeg[] {
  const total = duration && duration > 0 ? duration : blocks.length ? blocks[blocks.length - 1].end : 0;
  if (!total) return [];
  return blocks.map(b => {
    const kinds = [...new Set(annotations.filter(a => a.i === b.i).map(a => a.kind))].sort((x, y) => PRIORITY.indexOf(x) - PRIORITY.indexOf(y));
    const primary = kinds[0] ?? null;
    return {
      i: b.i, start: b.start, end: b.end, kinds, primary,
      left: (b.start / total) * 100, width: Math.max(0.15, ((b.end - b.start) / total) * 100),
      color: primary ? techniqueDef(primary).color : 'transparent',
    };
  });
}
/** Nombre d'occurrences par technique (légende). */
export const techniqueCounts = (annotations: Annotation[]) =>
  TECHNIQUES.map(t => ({ ...t, count: annotations.filter(a => a.kind === t.kind).length })).filter(t => t.count > 0);

/** Lit un flux JSON Lines (une valeur JSON par ligne) : renvoie les objets complets + le reste non terminé. */
export function parseJsonLines<T = unknown>(buffer: string): { items: T[]; rest: string } {
  const items: T[] = [];
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.trim().replace(/^```(?:json)?|```$/g, '').trim();
    if (!line || !/^[[{]/.test(line)) continue;
    try { items.push(JSON.parse(line) as T); } catch { /* ligne invalide ignorée */ }
  }
  return { items, rest };
}

const KINDS = new Set<string>(TECHNIQUES.map(t => t.kind));
/** Valide une annotation renvoyée par Claude. */
export function toAnnotation(raw: unknown, blockCount: number): Annotation[] {
  const r = raw as { i?: unknown; techniques?: { type?: unknown; kind?: unknown; explication?: unknown; why?: unknown; citation?: unknown; quote?: unknown }[] };
  const i = Number(r?.i);
  if (!Number.isInteger(i) || i < 0 || i >= blockCount || !Array.isArray(r.techniques)) return [];
  return r.techniques.flatMap(t => {
    const kind = String(t.type ?? t.kind ?? '').toLowerCase();
    if (!KINDS.has(kind)) return [];
    return [{ i, kind: kind as TechniqueKind, why: String(t.explication ?? t.why ?? '').slice(0, 400), quote: t.citation || t.quote ? clip(String(t.citation ?? t.quote), 200) : undefined, source: 'claude' as const }];
  });
}
