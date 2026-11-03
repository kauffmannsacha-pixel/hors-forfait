// Structure d'une transcription (hook, rythme, boucles ouvertes) — pour comparer deux vidéos côte à côte.
import type { Sentence } from './transcript';

export interface TranscriptStructure {
  words: number;
  /** Débit moyen (mots / minute de vidéo). */
  wpm: number;
  sentences: number;
  avgSentenceWords: number;
  questions: number;
  questionsPerMin: number;
  /** Marqueurs de boucle ouverte / tension (« mais », « sauf que », « vous verrez »…). */
  loopMarkers: number;
  loopsPerMin: number;
  /** Premier marqueur de boucle ouverte (s). */
  firstLoopAt: number | null;
  /** Texte de l'accroche (hookSec premières secondes). */
  hookText: string;
  hookWords: number;
  hookQuestions: number;
  /** Nombres cités dans l'accroche (enjeux chiffrés). */
  hookNumbers: number;
  /** Débit (mots/min) par tranche de 5 % de la durée. */
  paceBuckets: number[];
}

export const LOOP_MARKERS = /(?<![\p{L}\p{N}])(mais avant|mais|sauf que|sauf qu|pourtant|cependant|vous verrez|tu verras|plus tard|on y revient|jusqu'à la fin|à la fin|attendez|attends|le problème|et là|but|however|later|stay until|wait|until the end|the problem)(?![\p{L}\p{N}])/giu;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function transcriptStructure(sentences: Sentence[], durationSec: number, hookSec = 30): TranscriptStructure {
  const D = Math.max(1, durationSec);
  const minutes = D / 60;
  let words = 0, questions = 0, loops = 0;
  let firstLoopAt: number | null = null;
  const buckets = new Array(20).fill(0) as number[];
  for (const s of sentences) {
    const w = wordCount(s.text);
    words += w;
    questions += (s.text.match(/\?/g) ?? []).length;
    const m = s.text.replace(/’/g, '\'').match(LOOP_MARKERS);
    if (m?.length) { loops += m.length; if (firstLoopAt == null) firstLoopAt = s.start; }
    // répartit les mots de la phrase dans les tranches qu'elle couvre (au prorata du temps)
    const span = Math.max(0.01, s.end - s.start);
    for (let b = Math.floor((s.start / D) * 20); b <= Math.min(19, Math.floor((s.end / D) * 20)); b++) {
      const b0 = (b / 20) * D, b1 = ((b + 1) / 20) * D;
      const overlap = Math.max(0, Math.min(s.end, b1) - Math.max(s.start, b0));
      if (b >= 0) buckets[b] += (w * overlap) / span;
    }
  }
  const bucketMin = D / 20 / 60;
  const hookLimit = Math.min(hookSec, D * 0.25);
  const hook = sentences.filter(s => s.start < hookLimit);
  const hookText = hook.map(s => s.text).join(' ');
  return {
    words,
    wpm: words / minutes,
    sentences: sentences.length,
    avgSentenceWords: sentences.length ? words / sentences.length : 0,
    questions,
    questionsPerMin: questions / minutes,
    loopMarkers: loops,
    loopsPerMin: loops / minutes,
    firstLoopAt,
    hookText,
    hookWords: wordCount(hookText),
    hookQuestions: (hookText.match(/\?/g) ?? []).length,
    hookNumbers: (hookText.match(/\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g) ?? []).length,
    paceBuckets: buckets.map(w => w / bucketMin),
  };
}

const STOP = new Set('le la les un une des du de d l à au aux et ou en dans sur pour par avec sans ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles qui que quoi dont où est sont été être a ai as ont avoir fait faire pas ne plus très tout tous toute toutes j c qu n s y the a an of to in on for with and or is are was be my your this that it i you we they how why what vs ft feat'.split(' '));

/** Mots-clés d'un titre (et des tags) pour chercher des vidéos de référence du même thème. */
export function keywordsFromTitle(title: string, tags: string[] = [], max = 5): string {
  const norm = (s: string) => s
    .replace(/[’`]/g, '\'')
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, ' ')
    .replace(/[^\p{L}\p{N}' -]/gu, ' ')
    .toLowerCase();
  const words = norm(title)
    .split(/[\s']+/)
    .map(w => w.replace(/^-+|-+$/g, ''))
    .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const uniq: string[] = [];
  for (const w of words) if (!uniq.includes(w)) uniq.push(w);
  for (const t of tags) {
    if (uniq.length >= max) break;
    const tw = norm(t).trim();
    if (tw && tw.length > 2 && !uniq.includes(tw) && !STOP.has(tw)) uniq.push(tw);
  }
  return uniq.slice(0, max).join(' ');
}
