// Normalisation (pure) des réponses JSON de Claude : bornes, synonymes d'émotions, citations [n].
import { formatCitation, type Principle } from '../../../knowledge/api';
import { EMOTIONS, LAYOUTS, type Concept, type CritiqueProblem, type Emotion, type Layout, type MyCritique, type SketchItem, type VisionAnalysis } from './types';
import { isHexColor } from './color';

export const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
const low = (s: unknown) => stripAccents(String(s ?? '')).toLowerCase().trim();
const num = (v: unknown, d = 0) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : d; };
const bool = (v: unknown) => v === true || v === 'true' || v === 1 || /^(oui|yes|vrai)$/i.test(String(v ?? ''));
const str = (v: unknown, max = 600) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
const strList = (v: unknown, max = 8) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).map(x => str(x, 300)).filter(Boolean).slice(0, max);
export const clamp01n = (v: unknown, d = 0.5) => Math.min(1, Math.max(0, num(v, d)));

const EMOTION_SYNONYMS: [Emotion, string[]][] = [
  ['aucune', ['aucune', 'aucun', 'none', 'sans visage', 'pas de visage', 'n/a', 'na', 'null']],
  ['joie', ['joie', 'joy', 'happy', 'heureux', 'joyeux', 'rire', 'sourire', 'excite', 'excitation', 'enthousias', 'euphori', 'amuse', 'fun', 'triomph', 'fier']],
  ['surprise', ['surprise', 'surpris', 'shock', 'choc', 'choque', 'stupef', 'etonn', 'wow', 'bouche bee', 'incredul', 'emerveill', 'awe']],
  ['peur', ['peur', 'fear', 'effray', 'terreur', 'terrif', 'angoiss', 'anxi', 'inquiet', 'panique', 'scared', 'horreur']],
  ['colère', ['colere', 'anger', 'angry', 'enerve', 'furieux', 'furie', 'rage', 'agace', 'frustr']],
  ['tristesse', ['triste', 'sad', 'decu', 'decep', 'chagrin', 'pleur', 'desesp']],
  ['dégoût', ['degout', 'disgust', 'beurk', 'ecoeur', 'repugn']],
  ['curiosité', ['curio', 'curious', 'intrig', 'suspic', 'mefian', 'perplex', 'confus', 'interrog', 'doute', 'mystere']],
  ['détermination', ['determin', 'concentr', 'serieux', 'confian', 'defi', 'focus', 'motive', 'intense', 'cool']],
  ['neutre', ['neutre', 'neutral', 'calme', 'impassible', 'inexpressi']],
];
/** Ramène une émotion libre (FR/EN) à l'une des 10 émotions du filtre. */
export function normalizeEmotion(v: unknown, hasFace = true): Emotion {
  const s = low(v);
  if (!s) return hasFace ? 'neutre' : 'aucune';
  const exact = EMOTIONS.find(e => low(e) === s);
  if (exact) return exact === 'aucune' && hasFace ? 'neutre' : exact;
  for (const [e, keys] of EMOTION_SYNONYMS) if (keys.some(k => s.includes(k))) return e === 'aucune' && hasFace ? 'neutre' : e;
  return hasFace ? 'neutre' : 'aucune';
}
export function normalizeLayout(v: unknown): Layout {
  const s = low(v);
  const exact = LAYOUTS.find(l => low(l) === s); if (exact) return exact;
  if (/split|moitie|divis|vs|versus|compar/.test(s)) return 'split';
  if (/avant|apres|before|after/.test(s)) return 'avant-après';
  if (/tiers|third/.test(s)) return 'tiers';
  if (/gros plan|close/.test(s)) return 'gros plan';
  if (/large|wide|ensemble/.test(s)) return 'plan large';
  if (/centr|center|symetr/.test(s)) return 'centrée';
  return 'autre';
}
/** Nombre de mots d'un texte incrusté (chiffres et symboles « $ », « % » comptés comme mots s'ils sont isolés). */
export const countWords = (t: string) => t.split(/[\s\n\r]+/).filter(w => /[\p{L}\p{N}$€%!?]/u.test(w)).length;
/** Garde au plus n mots. */
export const limitWords = (t: string, n: number) => t.split(/\s+/).filter(Boolean).slice(0, n).join(' ');

/** Extrait les renvois [n] d'un texte, les retire et renvoie les citations correspondantes. */
export function extractCitations(text: string, principles: Principle[]): { text: string; citations: string[] } {
  const ids = new Set<number>();
  const cleaned = text.replace(/\s*\[(\d+(?:\s*[,;]\s*\d+)*)\]/g, (_m, g: string) => { g.split(/[,;]/).forEach(x => ids.add(parseInt(x, 10))); return ''; }).trim();
  return { text: cleaned, citations: [...ids].map(i => principles[i - 1]).filter(Boolean).map(formatCitation) };
}
const citeList = (items: string[], principles: Principle[]) => {
  const all: string[] = [];
  const texts = items.map(t => { const r = extractCitations(t, principles); all.push(...r.citations); return r.text; });
  return { texts, citations: [...new Set(all)] };
};

export function normalizeVision(raw: unknown, principles: Principle[] = []): VisionAnalysis {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = str(o.text, 160);
  const faceCount = Math.max(0, Math.round(num(o.faceCount, bool(o.face) ? 1 : 0)));
  const face = bool(o.face) || faceCount > 0;
  const hasText = bool(o.hasText) || text.length > 0;
  const words = text ? countWords(text) : 0;
  const elements = strList(o.elements, 8);
  const fp = (o.focalPoint && typeof o.focalPoint === 'object' ? o.focalPoint : {}) as Record<string, unknown>;
  const why = citeList(strList(o.whyItWorks, 5), principles);
  const weak = citeList(strList(o.weaknesses, 3), principles);
  return {
    face, faceCount: face ? Math.max(1, faceCount) : 0,
    emotion: normalizeEmotion(o.emotion, face), emotionIntensity: Math.min(10, Math.max(0, num(o.emotionIntensity, face ? 5 : 0))),
    elements, elementCount: Math.max(elements.length ? 1 : 0, Math.round(num(o.elementCount, elements.length))),
    hasText, text, wordCount: hasText ? (words || Math.max(1, Math.round(num(o.wordCount, 1)))) : 0,
    focalPoint: { x: clamp01n(fp.x), y: clamp01n(fp.y), description: str(fp.description, 200) },
    composition: str(o.composition, 300), layout: normalizeLayout(o.layout ?? o.composition),
    background: str(o.background, 200), colorStrategy: str(o.colorStrategy, 200), curiosity: str(o.curiosity, 300),
    whyItWorks: why.texts, weaknesses: weak.texts, citations: [...new Set([...why.citations, ...weak.citations])],
  };
}

export function normalizeCritique(raw: unknown, principles: Principle[] = []): MyCritique {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = str(o.text, 160);
  const face = bool(o.face);
  const fp = (o.focalPoint && typeof o.focalPoint === 'object' ? o.focalPoint : {}) as Record<string, unknown>;
  const all: string[] = [];
  const problems: CritiqueProblem[] = (Array.isArray(o.problems) ? o.problems : []).slice(0, 8).map((p): CritiqueProblem => {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const issue = extractCitations(str(q.issue, 400), principles), fix = extractCitations(str(q.fix, 400), principles);
    const idx = (Array.isArray(q.principles) ? q.principles : []).map(n => principles[Math.round(num(n)) - 1]).filter(Boolean).map(formatCitation);
    const sev = low(q.severity);
    const citations = [...new Set([...issue.citations, ...fix.citations, ...idx])]; all.push(...citations);
    return { issue: issue.text, fix: fix.text, severity: sev.startsWith('h') ? 'haute' : sev.startsWith('b') ? 'basse' : 'moyenne', citations };
  }).filter(p => p.issue);
  const strengths = citeList(strList(o.strengths, 6), principles), wins = citeList(strList(o.quickWins, 5), principles);
  all.push(...strengths.citations, ...wins.citations);
  return {
    score: Math.round(Math.min(10, Math.max(0, num(o.score, 5))) * 10) / 10,
    verdict: str(o.verdict, 300), face, emotion: normalizeEmotion(o.emotion, face), text, wordCount: text ? countWords(text) : 0,
    elementCount: Math.max(0, Math.round(num(o.elementCount, 0))),
    focalPoint: { x: clamp01n(fp.x), y: clamp01n(fp.y), description: str(fp.description, 200) },
    strengths: strengths.texts, problems, quickWins: wins.texts,
    titleSynergy: extractCitations(str(o.titleSynergy, 400), principles).text, smallSize: str(o.smallSize, 400),
    citations: [...new Set(all)],
  };
}

const SKETCH_KINDS: SketchItem['kind'][] = ['visage', 'personne', 'objet', 'texte', 'fleche', 'cercle', 'fond', 'split', 'halo'];
function sketchKind(v: unknown): SketchItem['kind'] {
  const s = low(v);
  const exact = SKETCH_KINDS.find(k => k === s); if (exact) return exact;
  if (/visage|face|tete|head/.test(s)) return 'visage';
  if (/perso|person|body|corps|silhou/.test(s)) return 'personne';
  if (/text|titre|mot/.test(s)) return 'texte';
  if (/fleche|arrow/.test(s)) return 'fleche';
  if (/cercle|circle|ring|entour/.test(s)) return 'cercle';
  if (/split|moitie|divis/.test(s)) return 'split';
  if (/halo|glow|lueur|lumiere/.test(s)) return 'halo';
  if (/fond|background|bg/.test(s)) return 'fond';
  return 'objet';
}
const color = (v: unknown, d: string) => { const s = str(v, 9); return isHexColor(s) ? s : d; };

export function normalizeConcept(raw: unknown, principles: Principle[] = [], idx = 0): Concept {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawText = str(o.text, 80).replace(/^["«\s]+|["»\s]+$/g, '');
  const text = limitWords(rawText, 3);
  const colors = strList(o.colors, 6).filter(isHexColor);
  const why = extractCitations(str(o.why, 600), principles);
  const sketch: SketchItem[] = (Array.isArray(o.sketch) ? o.sketch : []).slice(0, 12).map(it => {
    const q = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const kind = sketchKind(q.kind);
    const item: SketchItem = { kind, x: clamp01n(q.x, 0.1), y: clamp01n(q.y, 0.1), w: clamp01n(q.w, 0.3), h: clamp01n(q.h, 0.3), label: str(q.label, 40) || undefined, color: isHexColor(str(q.color, 9)) ? str(q.color, 9) : undefined };
    if (kind === 'visage' || kind === 'personne') item.emotion = normalizeEmotion(q.emotion ?? o.expression, true);
    if (kind === 'texte' && item.label) item.label = limitWords(item.label, 3);
    return item;
  });
  return {
    id: `c${idx + 1}-${Math.random().toString(36).slice(2, 7)}`,
    name: str(o.name, 60) || `Concept ${idx + 1}`, idea: str(o.idea, 300),
    shot: str(o.shot, 120), subject: str(o.subject, 200), expression: str(o.expression, 120),
    elements: strList(o.elements, 8), colors: colors.length ? colors : ['#111111', '#ffd60a', '#ffffff'], background: str(o.background, 200),
    text, textColor: color(o.textColor, '#ffffff'), textStroke: color(o.textStroke, '#000000'), textPosition: str(o.textPosition, 30) || 'haut-gauche',
    textTooLong: rawText.split(/\s+/).filter(Boolean).length > 3,
    focal: str(o.focal, 200), titleSynergy: str(o.titleSynergy, 300), why: why.text,
    sketch, imagePrompt: str(o.imagePrompt, 1200), citations: why.citations,
  };
}
