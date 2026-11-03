// Heuristiques locales instantanées du score en direct (aucun appel réseau).
// Entrée : une liste de blocs de texte (paragraphes / titres) ; sortie : timing, boucles, moments morts, conseils.
import { flagsOf, isReHook, type SentenceFlags } from './patterns';
import { DEFAULT_WPM, ISSUE_INFO, SECTION_DEFS, sectionKindOf, type IssueType, type SectionKind } from './method';

export interface ScriptBlock {
  text: string;
  heading?: number;   // niveau de titre (1-6)
  code?: boolean;     // bloc de code : ignoré
  top?: number;       // index du bloc de premier niveau (gouttière)
}
export interface AnalyzeOptions { wpm?: number; targetSec?: number; deadZoneSec?: number; style?: string }
/** Plage de texte : bloc + offset de début → bloc + offset de fin. */
export interface TextRange { b0: number; o0: number; b1: number; o1: number }

export interface Sentence { b: number; s: number; e: number; text: string; words: number; t: number; d: number; section: number; flags: SentenceFlags }
export interface SectionStat {
  index: number; kind: SectionKind; title: string; b: number; start: number; dur: number; words: number;
  target?: number; status: 'ok' | 'over' | 'under' | 'empty' | 'free';
}
export interface DeadZone { range: TextRange; t: number; dur: number; first: number; last: number }
export interface Issue {
  id: string; type: IssueType; severity: 'error' | 'warn' | 'info';
  message: string; fix: string; method: string;
  range?: TextRange; excerpt?: string; t?: number;
}
export interface ScorePart { id: 'hook' | 'promesse' | 'boucles' | 'rythme' | 'escalade' | 'payoff'; label: string; score: number; detail: string }
export interface ScriptAnalysis {
  wpm: number; words: number; durationSec: number; targetSec?: number; requiredWpm?: number; avgSentenceWords: number;
  sentences: Sentence[]; sections: SectionStat[]; blockTimes: (number | null)[];
  openLoops: number; questions: number; loopNotes: { open: number; close: number };
  twists: number; callbacks: number; escalations: number; deadZones: DeadZone[];
  hookSec: number | null; promiseSec: number | null; outroSec: number | null; isShort: boolean;
  issues: Issue[]; parts: ScorePart[]; score: number;
}

// ── Utilitaires purs ──────────────────────────────────────────
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
export const countWords = (s: string) => (s.match(WORD_RE) ?? []).length;
/** Durée parlée en secondes pour un nombre de mots à un débit donné (mots/min). */
export const secondsFor = (words: number, wpm = DEFAULT_WPM) => (words / Math.max(1, wpm)) * 60;
/** Débit nécessaire (mots/min) pour tenir une durée cible. */
export const requiredWpm = (words: number, targetSec: number) => (targetSec > 0 ? Math.round(words / (targetSec / 60)) : 0);
export const fmtClock = (sec: number) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const fmtDur = (sec: number) => { const s = Math.max(0, Math.round(sec)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`; };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
export function hashStr(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ── Lignes : voix vs indications (Visuel / Son / Boucle…) ─────
const DIRECTION_LABELS = ['visuel', 'visuels', 'b-roll', 'broll', 'b roll', 'plan large', 'gros plan', 'son', 'sons', 'sfx', 'musique', 'music', 'boucle', 'boucles',
  'note', 'notes', 'montage', 'ecran', 'texte a l\'ecran', 'texte ecran', 'camera', 'image', 'images', 'action', 'decor', 'lieu', 'transition', 'effet',
  'effets', 'fx', 'insert', 'overlay', 'source', 'sources', 'timing', 'duree', 'cut', 'zoom', 'graphique', 'miniature', 'titre', 'sound', 'visual', 'loop', 'scene'];
const SPOKEN_LABELS = ['voix', 'voix off', 'vo', 'dialogue', 'narration', 'narrateur', 'moi', 'parole', 'face cam', 'facecam', 'voice', 'voiceover', 'vocal'];
const LABEL_RE = /^[\s\p{Extended_Pictographic}️‍•*·\-–—>]*([\p{L}][\p{L}\s'’/-]{0,24}?)\s*[:：]/u;

export interface LineInfo { kind: 'spoken' | 'direction'; labelEnd: number; loop?: 'open' | 'close' }
export function classifyLine(text: string): LineInfo {
  const m = LABEL_RE.exec(text);
  if (m) {
    const label = norm(m[1]).replace(/’/g, "'");
    if (DIRECTION_LABELS.includes(label)) {
      let loop: LineInfo['loop'];
      if (label.startsWith('boucle') || label === 'loop') {
        const rest = norm(text.slice(m[0].length));
        loop = /ferm|close|resolu|payoff|recolt/.test(rest) && !/ouver|ouvre|open/.test(rest.slice(0, 12)) ? 'close' : 'open';
      }
      return { kind: 'direction', labelEnd: m[0].length, loop };
    }
    if (SPOKEN_LABELS.includes(label)) return { kind: 'spoken', labelEnd: m[0].length };
  }
  return { kind: 'spoken', labelEnd: 0 };
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');
const DIRECTION_PAREN = /\((?:\s*(?:sfx|son|musique|music|b-?roll|plan|zoom|visuel|cut|montage|bruit|rires?|silence|pause|insert|texte|[ée]cran|transition|off)\b)[^)]*\)/giu;
/** Masque (espaces, même longueur) tout ce qui n'est pas dit à voix haute : label, [indications], (SFX…), horodatage de tête. */
export function maskSpoken(text: string, labelEnd = 0): string {
  let m = blank(text.slice(0, labelEnd)) + text.slice(labelEnd);
  m = m.replace(/\[[^\]\n]*\]|\{[^}\n]*\}/g, blank).replace(DIRECTION_PAREN, blank);
  m = m.replace(/^(\s*)(\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?\s*[-–—:|]?)/, (_a, sp: string, ts: string) => sp + blank(ts));
  return m;
}

/** Découpe en phrases (offsets dans la chaîne fournie). */
export function splitSentences(text: string): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  let start = -1;
  const push = (s: number, e: number) => { while (e > s && /\s/.test(text[e - 1])) e--; if (e > s && countWords(text.slice(s, e))) out.push({ s, e }); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (/[\p{L}\p{N}«"“¿¡]/u.test(c)) start = i; else continue; }
    if (c === '\n') { push(start, i); start = -1; continue; }
    if ('.!?…'.includes(c)) {
      let j = i + 1;
      while (j < text.length && '.!?…»"”\')]'.includes(text[j])) j++;
      // Typographie française : « Super ! » (espace avant le guillemet fermant)
      let k = j;
      while (k < text.length && /[ \u00a0\u202f]/.test(text[k])) k++;
      if (k > j && k < text.length && '»”'.includes(text[k])) { j = k + 1; while (j < text.length && '»"”\')]'.includes(text[j])) j++; }
      if (j >= text.length || /\s/.test(text[j])) { push(start, j); start = -1; i = j - 1; }
    }
  }
  if (start >= 0) push(start, text.length);
  return out;
}

/** Blocs à partir d'un texte brut / Markdown léger (« # Titre », une ligne = un bloc). */
export function blocksFromPlainText(text: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) out.push({ text: h[2].replace(/\*\*/g, ''), heading: h[1].length, top: out.length });
    else out.push({ text: line.replace(/\*\*|__/g, '').replace(/^\s*[-*+]\s+/, ''), top: out.length });
  }
  return out;
}

/** Texte couvert par une plage. */
export function textOfRange(blocks: ScriptBlock[], r: TextRange): string {
  if (r.b0 === r.b1) return blocks[r.b0]?.text.slice(r.o0, r.o1) ?? '';
  const parts = [blocks[r.b0]?.text.slice(r.o0) ?? ''];
  for (let b = r.b0 + 1; b < r.b1; b++) parts.push(blocks[b]?.text ?? '');
  parts.push(blocks[r.b1]?.text.slice(0, r.o1) ?? '');
  return parts.join('\n');
}
const rangeOfSentences = (a: Sentence, z: Sentence): TextRange => ({ b0: a.b, o0: a.s, b1: z.b, o1: z.e });

// ── Analyse principale ────────────────────────────────────────
export function analyzeScript(blocks: ScriptBlock[], opts: AnalyzeOptions = {}): ScriptAnalysis {
  const wpm = clamp(Math.round(opts.wpm ?? DEFAULT_WPM), 60, 320);
  const targetSec = opts.targetSec && opts.targetSec > 0 ? opts.targetSec : undefined;
  const isShort = opts.style === 'short' || (targetSec != null && targetSec <= 75);
  const deadZoneSec = isShort ? Math.min(opts.deadZoneSec ?? 12, 15) : clamp(opts.deadZoneSec ?? 35, 20, 60);

  const sections: SectionStat[] = [];
  const sentences: Sentence[] = [];
  const blockTimes: (number | null)[] = blocks.map(() => null);
  const loopMarks: { t: number; type: 'open' | 'close'; b: number }[] = [];
  let t = 0;
  let cur: SectionStat | null = null;
  const ensureSection = (): SectionStat => {
    if (!cur) { cur = { index: sections.length, kind: 'libre', title: '', b: -1, start: t, dur: 0, words: 0, status: 'free' }; sections.push(cur); }
    return cur;
  };

  blocks.forEach((blk, b) => {
    if (blk.heading && blk.heading <= 2) {
      cur = { index: sections.length, kind: sectionKindOf(blk.text), title: blk.text.trim(), b, start: t, dur: 0, words: 0, status: 'free' };
      sections.push(cur);
      blockTimes[b] = t;
      return;
    }
    if (blk.heading) { if (!cur || cur.kind !== 'notes') blockTimes[b] = t; return; }
    if (blk.code || !blk.text.trim()) return;
    const sec = ensureSection();
    if (sec.kind === 'notes') return;
    const line = classifyLine(blk.text);
    if (line.kind === 'direction') { if (line.loop) loopMarks.push({ t, type: line.loop, b }); return; }
    const masked = maskSpoken(blk.text, line.labelEnd);
    for (const { s, e } of splitSentences(masked)) {
      const spoken = masked.slice(s, e).replace(/\s+/g, ' ').trim();
      const w = countWords(spoken);
      if (!w) continue;
      const d = secondsFor(w, wpm);
      sentences.push({ b, s, e, text: spoken, words: w, t, d, section: sec.index, flags: flagsOf(spoken) });
      if (blockTimes[b] == null) blockTimes[b] = t;
      t += d; sec.words += w;
    }
  });
  const total = t;
  sections.forEach((sec, i) => { sec.dur = (i + 1 < sections.length ? sections[i + 1].start : total) - sec.start; });
  assignTargets(sections, targetSec, isShort);

  // ── Comptages ──
  const words = sentences.reduce((n, s) => n + s.words, 0);
  const questions = sentences.filter(s => s.flags.question).length;
  const loopNotes = { open: loopMarks.filter(l => l.type === 'open').length, close: loopMarks.filter(l => l.type === 'close').length };
  const openLoops = sentences.filter(s => s.flags.openLoop).length + loopNotes.open;
  const twists = sentences.filter(s => s.flags.twist).length;
  const callbacks = sentences.filter(s => s.flags.callback).length + loopNotes.close;
  const escalations = sentences.filter(s => s.flags.escalation).length;
  const avgSentenceWords = sentences.length ? round1(words / sentences.length) : 0;

  // ── Moments morts : passages > seuil sans question / teaser / rebondissement / retour / palier ──
  const markedEvent = new Set<number>();
  for (const l of loopMarks) { const i = sentences.findIndex(s => s.t >= l.t - 0.01); if (i >= 0) markedEvent.add(i); }
  const deadZones: DeadZone[] = [];
  let zone: number[] = [];
  const flush = () => {
    if (!zone.length) return;
    const a = sentences[zone[0]], z = sentences[zone[zone.length - 1]];
    const dur = z.t + z.d - a.t;
    if (dur > deadZoneSec) deadZones.push({ range: rangeOfSentences(a, z), t: a.t, dur, first: zone[0], last: zone[zone.length - 1] });
    zone = [];
  };
  sentences.forEach((s, i) => { if (isReHook(s.flags) || markedEvent.has(i)) flush(); else zone.push(i); });
  flush();

  // ── Hook / promesse / sortie ──
  const first = sentences[0];
  const hookSec = first ? round1(first.d) : null;
  const promiseBy = isShort ? 6 : 30;
  const promiseSentence = sentences.find(s => s.flags.objective);
  const promiseSec = promiseSentence ? round1(promiseSentence.t) : null;
  const ctaSection = [...sections].reverse().find(s => s.kind === 'cta' && s.words > 0);
  const payoffSection = sections.find(s => s.kind === 'payoff' && s.words > 0);
  const lateStart = total * 0.7;
  const payoffMarkers = sentences.filter(s => s.t >= lateStart && s.flags.payoff);
  const outroSec = ctaSection ? round1(ctaSection.dur) : null;

  // ── Conseils ──
  const issues: Issue[] = [];
  const add = (type: IssueType, severity: Issue['severity'], message: string, fix: string, range?: TextRange, at?: number) => {
    const excerpt = range ? textOfRange(blocks, range) : undefined;
    issues.push({ id: `${type}:${hashStr(norm(excerpt ?? '').slice(0, 160))}`, type, severity, message, fix, method: ISSUE_INFO[type].method, range, excerpt, t: at });
  };
  const sRange = (s: Sentence) => rangeOfSentences(s, s);

  for (const s of sentences.filter(x => x.t < 30 && x.flags.greeting).slice(0, 2))
    add('greeting', 'error', 'Pas de « salut à tous » ni de présentation : entre directement dans le hook, la 1re seconde doit arrêter le scroll.',
      'Supprime la salutation / présentation et attaque directement par le hook (problème + prétexte, cold open sur la meilleure réaction, quiz ou constat choc), sans perdre l\'information utile.', sRange(s), s.t);
  if (first && first.d > (isShort ? 3 : 5) && !first.flags.greeting)
    add('hookLong', 'warn', `Ta première phrase dure ≈ ${Math.round(first.d)} s : le concept doit être posé en moins de ${isShort ? 3 : 5} s.`,
      `Réécris cette première phrase pour qu'elle se dise en moins de ${isShort ? 3 : 5} secondes (≈ ${Math.round(wpm * (isShort ? 3 : 5) / 60)} mots), percutante, et qu'elle confirme la miniature.`, sRange(first), 0);
  for (const s of sentences.filter(x => x.t < Math.min(60, Math.max(8, total * 0.15)) && x.flags.ctaEarly).slice(0, 1))
    add('ctaEarly', 'warn', '« Abonnez-vous » dans l\'intro fait partir les gens : garde le CTA pour la sortie (ou intègre-le au récit).',
      'Retire l\'appel à s\'abonner / liker de ce passage d\'intro et remplace-le par une relance de la curiosité (enjeu ou teaser).', sRange(s), s.t);
  for (const s of sentences.filter(x => x.t < 60 && x.flags.sponsor).slice(0, 1))
    add('sponsorEarly', 'warn', 'Sponsor annoncé dès l\'intro : intègre-le au milieu, comme une nécessité de l\'histoire.',
      'Retire la mention du sponsor de l\'intro et remplace-la par l\'objectif ou un enjeu ; le sponsor sera intégré plus loin comme une nécessité du récit.', sRange(s), s.t);
  if (sentences.length >= 3 && (promiseSec == null || promiseSec > promiseBy)) {
    const intro = sentences.filter(s => s.t < promiseBy);
    const r = intro.length ? rangeOfSentences(intro[0], intro[intro.length - 1]) : undefined;
    add('noPromise', 'warn', `Aucun objectif annoncé avant ${promiseBy} s : dis ce que tu vas faire, pourquoi c'est risqué, ce qu'on ne sait pas encore — et le plan.`,
      'Réécris ce passage d\'intro pour annoncer clairement l\'objectif, les enjeux chiffrés et concrets, et le plan, sans dévoiler le résultat.', r, 0);
  }
  for (const z of deadZones)
    add('deadZone', 'warn', `Ce passage de ${Math.round(z.dur)} s n'a aucun re-hook — ajoute une question, un teaser ou un rebondissement.`,
      'Garde les informations de ce passage mais insère au moins un re-hook (question au spectateur, teaser d\'un moment à venir, obstacle ou rebondissement) toutes les 20-30 s, à l\'oral.', z.range, z.t);
  const longOnes = sentences.filter(s => s.words > 28).sort((a, b) => b.words - a.words).slice(0, 6);
  for (const s of longOnes)
    add('longSentence', 'info', `Phrase de ${s.words} mots (≈ ${Math.round(s.d)} s) : coupe-la, c'est un script parlé.`,
      'Découpe cette phrase en phrases courtes et orales, sans perdre d\'information.', sRange(s), s.t);
  for (const s of sentences.filter(x => x.t >= total * 0.75 && x.flags.recap).slice(0, 2))
    add('recap', 'warn', 'Pas de récap ni de « voilà c\'était tout » : livre le payoff, un dernier moment qui fait réagir, puis coupe.',
      'Remplace ce récap par une sortie sèche : un dernier moment drôle ou inattendu qui fait commenter, puis « Si vous avez aimé cette vidéo, vous allez adorer celle-ci. Abonnez-vous parce que la vidéo est terminée. »', sRange(s), s.t);
  if (ctaSection && ctaSection.dur > 15) {
    const ss = sentences.filter(s => s.section === ctaSection.index);
    add('outroLong', 'warn', `Plus de 15 s après le payoff (≈ ${Math.round(ctaSection.dur)} s) : coupe la fin.`,
      'Raccourcis cette fin à moins de 15 secondes (≈ 35 mots), sortie sèche, sans récap.', ss.length ? rangeOfSentences(ss[0], ss[ss.length - 1]) : undefined, ctaSection.start);
  }
  const longEnough = total >= (isShort ? 15 : 90);
  if (longEnough && openLoops === 0) {
    const intro = sentences.filter(s => s.t < (isShort ? 10 : 60));
    add('noLoops', 'warn', 'Aucune boucle ouverte annoncée : dis à voix haute ce qui arrive (« plus tard dans cette vidéo… », « retenez bien ça, on va y revenir »).',
      'Ajoute dans ce passage une boucle ouverte explicite, annoncée à voix haute, qui donne envie de rester jusqu\'à sa résolution.', intro.length ? rangeOfSentences(intro[0], intro[intro.length - 1]) : undefined);
  }
  if (longEnough && !isShort && escalations < 3)
    add('fewEscalation', 'info', `${escalations} palier${escalations > 1 ? 's' : ''} d'escalade détecté${escalations > 1 ? 's' : ''} : vise au moins 3 paliers (petit test → moyen → énorme), jamais deux d'intensité égale d'affilée.`,
      'Réécris ce passage pour qu\'il marque clairement un palier supérieur (« cette fois… », « on passe à… »), avec un obstacle réel.');
  if (longEnough && !payoffSection && payoffMarkers.length === 0) {
    const last = sentences.slice(-3);
    add('noPayoff', 'warn', 'Pas de payoff identifiable : la fin doit livrer exactement la promesse du titre, de la façon la plus satisfaisante.',
      'Réécris cette fin pour livrer clairement la promesse du titre (révélation, résultat), puis un dernier moment qui fait réagir.', last.length ? rangeOfSentences(last[0], last[last.length - 1]) : undefined, last[0]?.t);
  }
  if (targetSec && total > targetSec * 1.15 && total - targetSec > 15)
    add('tooLong', 'info', `Script trop long : ≈ ${fmtClock(total)} pour ${fmtClock(targetSec)} visés (${requiredWpm(words, targetSec)} mots/min nécessaires). Coupe ce qui n'apporte ni enjeu, ni info, ni rire.`, '');
  if (targetSec && words > 40 && total < targetSec * 0.6)
    add('tooShort', 'info', `Script court : ≈ ${fmtClock(total)} pour ${fmtClock(targetSec)} visés. Ajoute un palier, un obstacle ou un fil parallèle plutôt que du remplissage.`, '');

  // ── Score local /10 ──
  const parts = scoreParts({ sentences, total, isShort, deadZones, openLoops, questions, escalations, promiseSec, promiseBy, payoffOk: !!payoffSection || payoffMarkers.length > 0, ctaSection, issues, avgSentenceWords, longCount: longOnes.length });
  const W: Record<ScorePart['id'], number> = { hook: 0.25, promesse: 0.15, boucles: 0.2, rythme: 0.15, escalade: 0.1, payoff: 0.15 };
  const score = sentences.length ? round1(parts.reduce((n, p) => n + p.score * W[p.id], 0)) : 0;

  return {
    wpm, words, durationSec: total, targetSec, requiredWpm: targetSec ? requiredWpm(words, targetSec) : undefined, avgSentenceWords,
    sentences, sections, blockTimes, openLoops, questions, loopNotes, twists, callbacks, escalations, deadZones,
    hookSec, promiseSec, outroSec, isShort, issues, parts, score,
  };
}

function assignTargets(sections: SectionStat[], targetSec: number | undefined, isShort: boolean) {
  const counts = new Map<SectionKind, number>();
  for (const s of sections) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  for (const s of sections) {
    const def = SECTION_DEFS.find(d => d.kind === s.kind);
    if (s.kind === 'notes') { s.status = 'free'; continue; }
    if (def && targetSec) {
      let tgt = (targetSec * def.share) / (counts.get(s.kind) ?? 1);
      const max = isShort ? (s.kind === 'hook' ? 3 : def.max) : def.max;
      tgt = clamp(tgt, isShort ? 1 : def.min ?? 1, max ?? Infinity);
      s.target = Math.round(tgt);
    }
    if (s.words === 0) s.status = 'empty';
    else if (s.kind === 'hook' && s.dur > (isShort ? 5 : 30)) s.status = 'over';
    else if (s.kind === 'cta' && s.dur > 15) s.status = 'over';
    else if (s.target == null) s.status = 'free';
    else if (s.dur > s.target * 1.3 + 3) s.status = 'over';
    else if (s.dur < s.target * 0.5) s.status = 'under';
    else s.status = 'ok';
  }
}

function scoreParts(x: {
  sentences: Sentence[]; total: number; isShort: boolean; deadZones: DeadZone[]; openLoops: number; questions: number; escalations: number;
  promiseSec: number | null; promiseBy: number; payoffOk: boolean; ctaSection?: SectionStat; issues: Issue[]; avgSentenceWords: number; longCount: number;
}): ScorePart[] {
  const has = (t: IssueType) => x.issues.some(i => i.type === t);
  const first = x.sentences[0];
  // Hook
  let hook = 10; const hookNotes: string[] = [];
  if (first) {
    const lim = x.isShort ? 3 : 5;
    if (first.d > lim) { hook -= Math.min(4, (first.d - lim) * 0.8); hookNotes.push(`1re phrase ≈ ${Math.round(first.d)} s`); }
    if (has('greeting')) { hook -= 3.5; hookNotes.push('salutation'); }
    if (has('ctaEarly')) { hook -= 1; hookNotes.push('CTA en intro'); }
    const win = x.isShort ? 3 : 10;
    if (!x.sentences.some(s => s.t < win && isReHook(s.flags))) { hook -= 2; hookNotes.push(`aucune question/teaser avant ${win} s`); }
  } else hook = 0;
  // Promesse
  let prom = x.promiseSec != null && x.promiseSec <= x.promiseBy ? 7 : x.promiseSec != null ? 4 : 2;
  const stakes = x.sentences.some(s => s.t < (x.isShort ? 15 : 60) && s.flags.stakes);
  if (stakes) prom += 3;
  if (has('sponsorEarly')) prom -= 2;
  // Boucles
  const minutes = Math.max(x.isShort ? 0.25 : 1, x.total / 60);
  const perMin = (x.openLoops + 0.5 * x.questions) / minutes;
  let loops = Math.min(10, (10 * perMin) / (x.isShort ? 2 : 0.7));
  if (x.openLoops > 0) loops = Math.min(10, loops + 1);
  // Rythme
  let rythme = 10 - 2.5 * x.deadZones.length - 0.5 * x.longCount - (x.avgSentenceWords > 18 ? (x.avgSentenceWords - 18) * 0.4 : 0);
  // Escalade
  const esc = x.isShort ? (x.escalations >= 1 ? 10 : 6) : Math.min(10, (x.escalations / 3) * 10);
  // Payoff
  let pay = x.payoffOk ? 8 : x.total < 90 ? 5 : 3;
  if (x.ctaSection && x.ctaSection.dur > 15) pay -= 3;
  if (has('recap')) pay -= 3;
  if (x.payoffOk && !has('recap') && !(x.ctaSection && x.ctaSection.dur > 15)) pay += 2;
  const c = (v: number) => round1(clamp(v, 0, 10));
  return [
    { id: 'hook', label: 'Hook', score: c(hook), detail: hookNotes.length ? hookNotes.join(' · ') : 'Hook court et direct' },
    { id: 'promesse', label: 'Promesse', score: c(prom), detail: x.promiseSec != null ? `Objectif annoncé à ${fmtClock(x.promiseSec)}${stakes ? ' · enjeux chiffrés' : ' · enjeux non chiffrés'}` : 'Objectif non détecté' },
    { id: 'boucles', label: 'Boucles', score: c(loops), detail: `${x.openLoops} boucle${x.openLoops > 1 ? 's' : ''} · ${x.questions} question${x.questions > 1 ? 's' : ''}` },
    { id: 'rythme', label: 'Rythme', score: c(rythme), detail: `${x.deadZones.length} moment${x.deadZones.length > 1 ? 's' : ''} mort${x.deadZones.length > 1 ? 's' : ''} · ${x.avgSentenceWords} mots/phrase` },
    { id: 'escalade', label: 'Escalade', score: c(esc), detail: `${x.escalations} palier${x.escalations > 1 ? 's' : ''} détecté${x.escalations > 1 ? 's' : ''}` },
    { id: 'payoff', label: 'Payoff', score: c(pay), detail: x.payoffOk ? (x.ctaSection ? `Sortie ≈ ${Math.round(x.ctaSection.dur)} s` : 'Payoff présent') : 'Payoff non identifié' },
  ];
}

/** Score local du hook (utilisé par scoreHook) : 30 premières secondes. */
export function hookLocal(a: ScriptAnalysis): { score: number; reasons: string[] } {
  const p = a.parts.find(x => x.id === 'hook');
  if (!p || !a.sentences.length) return { score: 0, reasons: ['Aucun texte parlé détecté.'] };
  const reasons: string[] = [];
  if (a.hookSec != null) reasons.push(a.hookSec <= (a.isShort ? 3 : 5) ? `Première phrase ≈ ${Math.round(a.hookSec)} s : concept posé vite.` : `Première phrase trop longue (≈ ${Math.round(a.hookSec)} s) : vise moins de 5 s.`);
  for (const i of a.issues.filter(x => ['greeting', 'ctaEarly', 'sponsorEarly', 'noPromise'].includes(x.type))) reasons.push(i.message);
  if (a.promiseSec != null && a.promiseSec <= 30) reasons.push(`Objectif annoncé à ${fmtClock(a.promiseSec)}.`);
  const early = a.sentences.filter(s => s.t < 30);
  const loops = early.filter(s => s.flags.openLoop || s.flags.question).length;
  reasons.push(loops ? `${loops} boucle${loops > 1 ? 's' : ''} / question${loops > 1 ? 's' : ''} dans les 30 premières secondes.` : 'Aucune boucle ouverte dans les 30 premières secondes.');
  const promise = a.parts.find(x => x.id === 'promesse')?.score ?? 0;
  return { score: round1(clamp(p.score * 0.7 + promise * 0.3, 0, 10)), reasons };
}
