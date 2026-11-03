// Chapitres YouTube générés depuis une page Script (pure, testée).
// Règles YouTube : 1er chapitre à 00:00, au moins 3 chapitres, ordre croissant, 10 s minimum chacun.
import type { Chapter } from './types';

export const MIN_CHAPTER_SEC = 10;
export const MIN_CHAPTERS = 3;
export const DEFAULT_WPM = 160; // débit parlé moyen d'un créateur francophone

export interface ScriptSection { title: string; text: string; words: number; level: number; start?: number }

// ── Temps ────────────────────────────────────────────────────
/** « 1:30 » → 90, « 01:02:03 » → 3723, « 45 s » → 45, « 2 min 10 » → 130, « 90 » → 90. */
export function parseTimestamp(s: string): number | null {
  const t = s.trim().toLowerCase();
  let m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(t);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = /^(\d{1,3}):(\d{2})$/.exec(t);
  if (m) return +m[1] * 60 + +m[2];
  m = /^(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|secondes?)$/.exec(t);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')));
  m = /^(\d+)\s*(?:min|mn|m)\s*(?:(\d{1,2})\s*(?:s|sec)?)?$/.exec(t);
  if (m) return +m[1] * 60 + (m[2] ? +m[2] : 0);
  if (/^\d+$/.test(t)) return +t;
  return null;
}

/** 0 → « 00:00 », 75 → « 01:15 », 3725 → « 1:02:05 » (format heures si la vidéo dure ≥ 1 h). */
export function formatTimestamp(sec: number, withHours = sec >= 3600): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return withHours ? `${h}:${p2(m)}:${p2(r)}` : `${p2(m + h * 60)}:${p2(r)}`;
}

const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
/** Sépare un éventuel minutage écrit dans un intertitre : « [1:30] Corps », « Hook (0-30 s) », « Payoff — 8:10 ». */
export function extractHeadingTime(raw: string): { title: string; start?: number } {
  const s = raw.replace(/\s+/g, ' ').trim();
  let m = new RegExp(`^[\\[(]?(${TS})[\\])]?\\s*[-–—:|·]?\\s*(.+)$`).exec(s);
  if (m) return { title: m[2].trim(), start: parseTimestamp(m[1]) ?? undefined };
  m = new RegExp(`^(.*?)\\s*[\\[(]\\s*(${TS}|\\d+\\s*s)\\s*(?:[-–à]\\s*(?:${TS}|\\d+\\s*s))?\\s*[\\])]\\s*$`).exec(s);
  if (m && m[1]) return { title: m[1].trim(), start: parseTimestamp(m[2]) ?? undefined };
  m = /^(.*?)\s*[[(]\s*(\d+(?:[.,]\d+)?)\s*(?:[-–à]\s*\d+(?:[.,]\d+)?)?\s*(s|sec|min|mn)\s*[\])]\s*$/i.exec(s);
  if (m && m[1]) { const n = parseFloat(m[2].replace(',', '.')); return { title: m[1].trim(), start: Math.round(/^m/i.test(m[3]) ? n * 60 : n) }; }
  m = new RegExp(`^(.*?)\\s*[-–—|·]\\s*(${TS})\\s*$`).exec(s);
  if (m && m[1]) return { title: m[1].trim(), start: parseTimestamp(m[2]) ?? undefined };
  return { title: s };
}

/** Mots réellement prononcés (les indications entre crochets [SFX], [B-roll…] sont ignorées). */
export function countSpokenWords(text: string): number {
  const spoken = text.replace(/\[[^\]]*\]/g, ' ');
  return (spoken.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

// ── Lecture d'une page Script ────────────────────────────────
type PMNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: PMNode[] };
function nodeText(n: PMNode): string {
  if (typeof n.text === 'string') return n.text;
  if (n.type === 'hardBreak') return '\n';
  const kids = n.content ?? [];
  if (!kids.length) return typeof n.attrs?.label === 'string' ? n.attrs.label : '';
  const inline = kids.some(c => typeof c.text === 'string' || c.type === 'hardBreak');
  return kids.map(nodeText).join(inline ? '' : '\n');
}

/** Découpe un document TipTap en sections (un intertitre = une section). */
export function docToSections(doc: unknown): ScriptSection[] {
  const root = doc as PMNode | null;
  const nodes = root && Array.isArray(root.content) ? root.content : [];
  const out: ScriptSection[] = [];
  let cur: ScriptSection | null = null;
  const push = () => { if (cur) { cur.text = cur.text.trim(); cur.words = countSpokenWords(cur.text); out.push(cur); } };
  for (const n of nodes) {
    if (n.type === 'heading') {
      push();
      const { title, start } = extractHeadingTime(nodeText(n));
      cur = { title, text: '', words: 0, level: Number(n.attrs?.level ?? 2), ...(start != null ? { start } : {}) };
    } else {
      const t = nodeText(n).trim();
      if (!t) continue;
      if (!cur) cur = { title: 'Introduction', text: '', words: 0, level: 2 };
      cur.text += (cur.text ? '\n' : '') + t;
    }
  }
  push();
  // Si le script a des H1 + H2, on garde le niveau le plus haut présent plusieurs fois comme découpage.
  const levels = [...new Set(out.map(s => s.level))].sort();
  if (levels.length > 1) {
    const top = levels.find(l => out.filter(s => s.level === l).length >= 2);
    if (top != null) {
      const merged: ScriptSection[] = [];
      for (const s of out) {
        if (s.level <= top || !merged.length) merged.push({ ...s });
        else { const p = merged[merged.length - 1]; p.text = [p.text, s.text].filter(Boolean).join('\n'); p.words += s.words; }
      }
      return merged;
    }
  }
  return out;
}

const pick = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return undefined; };
/** Sections déclarées par l'assistant Script dans page.meta (format toléré : chapters/sections/structure/timings…). */
export function sectionsFromMeta(meta: unknown): ScriptSection[] | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  for (const key of ['chapters', 'chapitres', 'sections', 'structure', 'timings', 'beats', 'blocks', 'parts']) {
    const arr = m[key];
    if (!Array.isArray(arr) || !arr.length) continue;
    const secs: ScriptSection[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const rawTitle = pick(o, ['title', 'titre', 'name', 'nom', 'label', 'heading', 'kind', 'type']);
      if (typeof rawTitle !== 'string') continue;
      const text = String(pick(o, ['text', 'texte', 'content', 'body', 'script']) ?? '');
      const rawStart = pick(o, ['start', 'startSec', 'start_s', 'startTime', 'debut', 'début', 'time', 'at', 't', 'timestamp', 'timing', 'offset', 'from']);
      let start: number | undefined;
      if (typeof rawStart === 'number' && Number.isFinite(rawStart)) start = Math.max(0, Math.round(rawStart));
      else if (typeof rawStart === 'string') {
        const first = rawStart.split(/\s*[-–à]\s*/)[0].trim();          // « 0-30 s » → « 0 », « 1:30 - 2:00 » → « 1:30 »
        const p = parseTimestamp(first);
        if (p != null) start = /^\d+$/.test(first) && /\b(min|mn)\b/i.test(rawStart) ? p * 60 : p;
      }
      const extracted = extractHeadingTime(rawTitle);
      const words = typeof o.words === 'number' ? o.words : typeof o.wordCount === 'number' ? o.wordCount : countSpokenWords(text);
      secs.push({ title: extracted.title, text, words, level: 2, ...(start != null ? { start } : extracted.start != null ? { start: extracted.start } : {}) });
    }
    if (secs.length) return secs;
  }
  return null;
}

/** Débit de parole déclaré par la page Script (mots/minute), sinon défaut. */
export function scriptWpm(meta: unknown): number {
  const m = (meta ?? {}) as Record<string, unknown>;
  const v = Number(m.wpm ?? m.wordsPerMinute ?? m.motsParMinute ?? m.debit);
  return Number.isFinite(v) && v >= 60 && v <= 400 ? v : DEFAULT_WPM;
}

/** Sections d'une page Script : page.meta d'abord, sinon le contenu (intertitres). */
export function scriptSections(page: { content?: unknown; meta?: Record<string, unknown> }): ScriptSection[] {
  return sectionsFromMeta(page.meta) ?? docToSections(page.content);
}

// ── Titres de chapitres ─────────────────────────────────────
const STRUCTURAL = /^(hook|accroche|promesse|intro|introduction|intrigue|boucles?\s+ouvertes?|corps|d[ée]veloppement|re-?hooks?|relance|escalade|payoff|apog[ée]e|r[ée]compense|cta|appel\s+[àa]\s+l['’]action|conclusion|outro|objectif|enjeux|plan|teaser|foreshadowing|histoire|climax|fin)\b/i;
const GENERIC: Record<string, string> = {
  hook: 'Introduction', accroche: 'Introduction', intro: 'Introduction', introduction: 'Introduction', teaser: 'Introduction',
  promesse: 'Le défi', objectif: 'Le défi', enjeux: 'Les enjeux', plan: 'Le plan', intrigue: 'Le début', histoire: "L'histoire",
  corps: 'Le cœur de la vidéo', développement: 'Le cœur de la vidéo', developpement: 'Le cœur de la vidéo', escalade: 'Ça monte',
  payoff: 'Le résultat', apogée: 'Le résultat', apogee: 'Le résultat', climax: 'Le résultat', récompense: 'Le résultat', recompense: 'Le résultat',
  cta: 'Pour finir', conclusion: 'Pour finir', outro: 'Pour finir', fin: 'Pour finir', relance: 'Rebondissement', rehook: 'Rebondissement', 're-hook': 'Rebondissement',
};
const cap = (s: string) => s ? s[0].toLocaleUpperCase('fr-FR') + s.slice(1) : s;
function shorten(s: string, max = 48): string {
  const clean = s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().replace(/^[«"“-]\s*/, '');
  const sentence = clean.split(/(?<=[.!?…])\s/)[0] ?? clean;
  if (sentence.length <= max) return sentence.replace(/[.…]+$/, '');
  const cut = sentence.slice(0, max); const sp = cut.lastIndexOf(' ');
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, '') + '…';
}
/** Titre lisible pour le spectateur (les étiquettes de structure Hook/CTA… sont remplacées). */
export function chapterTitle(sec: Pick<ScriptSection, 'title' | 'text'>): string {
  const t = sec.title.replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  const m = STRUCTURAL.exec(t);
  if (!m) return cap(t).slice(0, 100);
  const rest = t.slice(m[0].length).replace(/^\s*\d*\s*[-–—:|·]\s*/, '').replace(/^\s*\d+\s*$/, '').trim();
  if (rest.length >= 3) return cap(rest).slice(0, 100);
  if (sec.text.trim()) return cap(shorten(sec.text));
  return GENERIC[m[1].toLowerCase()] ?? cap(t);
}

// ── Génération + validation ──────────────────────────────────
export interface ChapterGen { chapters: Chapter[]; warnings: string[]; estimated: boolean }

/** Minutages : explicites quand ils existent, sinon interpolés au nombre de mots (et recalés sur la durée réelle si connue). */
export function sectionStarts(sections: ScriptSection[], wpm = DEFAULT_WPM, durationSec?: number | null): { starts: number[]; estimated: boolean } {
  const n = sections.length;
  const cum: number[] = []; let acc = 0;
  for (const s of sections) { cum.push(acc); acc += Math.max(0, s.words); }
  const totalWords = acc;
  const anchors: { i: number; t: number; w: number }[] = [];
  sections.forEach((s, i) => { if (s.start != null) anchors.push({ i, t: s.start, w: cum[i] }); });
  const estimated = anchors.length < n;
  if (!anchors.length) {
    const est = (w: number) => (w / wpm) * 60;
    const estTotal = est(totalWords);
    const k = durationSec && estTotal > 0 ? durationSec / estTotal : 1;
    return { starts: cum.map(w => Math.round(est(w) * k)), estimated: true };
  }
  if (anchors[0].i !== 0) anchors.unshift({ i: 0, t: 0, w: 0 });
  const last = anchors[anchors.length - 1];
  const endT = durationSec && durationSec > last.t ? durationSec : last.t + ((totalWords - last.w) / wpm) * 60;
  const ends = [...anchors, { i: n, t: endT, w: totalWords }];
  const starts = sections.map((s, i) => {
    if (s.start != null) return Math.round(s.start);
    let a = ends[0], b = ends[ends.length - 1];
    for (const x of ends) { if (x.i <= i) a = x; if (x.i > i) { b = x; break; } }
    return Math.round(b.w === a.w ? a.t : a.t + ((cum[i] - a.w) / (b.w - a.w)) * (b.t - a.t));
  });
  return { starts, estimated };
}

export function normalizeChapters(chapters: Chapter[], durationSec?: number | null, minSec = MIN_CHAPTER_SEC): Chapter[] {
  const sorted = chapters.filter(c => c.title.trim()).map(c => ({ start: Math.max(0, Math.floor(c.start)), title: c.title.trim() })).sort((a, b) => a.start - b.start);
  if (!sorted.length) return [];
  sorted[0] = { ...sorted[0], start: 0 };
  const kept: Chapter[] = [sorted[0]];
  for (const c of sorted.slice(1)) {
    if (durationSec && c.start >= durationSec) break;
    if (c.start - kept[kept.length - 1].start >= minSec) kept.push(c);
  }
  while (durationSec && kept.length > 1 && durationSec - kept[kept.length - 1].start < minSec) kept.pop();
  return kept;
}

export function generateChapters(sections: ScriptSection[], opts: { wpm?: number; durationSec?: number | null } = {}): ChapterGen {
  const usable = sections.filter(s => s.words > 0 || s.text.trim() || s.start != null);
  const warnings: string[] = [];
  if (!usable.length) return { chapters: [], warnings: ['Le script ne contient aucune section (ajoute des intertitres).'], estimated: false };
  const { starts, estimated } = sectionStarts(usable, opts.wpm ?? DEFAULT_WPM, opts.durationSec);
  const raw = usable.map((s, i) => ({ start: starts[i], title: chapterTitle(s) }));
  const chapters = normalizeChapters(raw, opts.durationSec);
  if (raw.length > chapters.length) warnings.push(`${raw.length - chapters.length} section(s) trop courte(s) (< ${MIN_CHAPTER_SEC} s) fusionnée(s) avec la précédente.`);
  if (estimated) warnings.push(`Minutages estimés à partir du nombre de mots (≈ ${opts.wpm ?? DEFAULT_WPM} mots/min)${opts.durationSec ? ', recalés sur la durée réelle de la vidéo' : ''} : vérifie-les après le montage.`);
  if (chapters.length < MIN_CHAPTERS) warnings.push('Moins de 3 chapitres : YouTube ne les affichera pas.');
  return { chapters, warnings, estimated };
}

/** Problèmes bloquants pour l'affichage des chapitres par YouTube. */
export function validateChapters(chapters: Chapter[], durationSec?: number | null): string[] {
  const issues: string[] = [];
  if (!chapters.length) return issues;
  if (chapters.length < MIN_CHAPTERS) issues.push('Il faut au moins 3 chapitres pour que YouTube les affiche.');
  if (chapters[0].start !== 0) issues.push('Le premier chapitre doit commencer à 00:00.');
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (!c.title.trim()) issues.push(`Le chapitre à ${formatTimestamp(c.start)} n'a pas de titre.`);
    if (i > 0 && c.start <= chapters[i - 1].start) { issues.push('Les chapitres doivent être dans l’ordre croissant.'); break; }
    const next = i + 1 < chapters.length ? chapters[i + 1].start : durationSec ?? null;
    if (next != null && next - c.start < MIN_CHAPTER_SEC) issues.push(`Le chapitre « ${c.title || formatTimestamp(c.start)} » dure moins de 10 secondes.`);
    if (durationSec && c.start >= durationSec) issues.push(`Le chapitre « ${c.title} » commence après la fin de la vidéo.`);
  }
  return [...new Set(issues)];
}

/** Bloc de description « 00:00 Titre » (une ligne par chapitre). */
export function chaptersToText(chapters: Chapter[], durationSec?: number | null): string {
  const hours = (durationSec ?? 0) >= 3600 || chapters.some(c => c.start >= 3600);
  return chapters.map(c => `${formatTimestamp(c.start, hours)} ${c.title.replace(/[<>]/g, '')}`).join('\n');
}
