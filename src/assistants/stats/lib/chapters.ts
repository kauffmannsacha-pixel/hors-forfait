// Chapitres : extraits des horodatages de la description (format YouTube « 0:00 Intro »).
// Règles YouTube pour que les chapitres soient actifs : 1er horodatage à 0:00, au moins 3 chapitres,
// ordre croissant, chaque chapitre ≥ 10 s.

export interface Chapter { index: number; start: number; end: number; title: string }
export interface ChaptersResult {
  chapters: Chapter[];
  /** true si YouTube activera ces chapitres. */
  valid: boolean;
  /** Problèmes détectés (en français). */
  issues: string[];
}

/** « 1:02:03 » → 3723 ; « 12:05 » → 725 ; « 75:30 » → 4530 ; null si invalide. */
export function parseTimestamp(s: string): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = m[1] != null ? Number(m[1]) : 0, mi = Number(m[2]), se = Number(m[3]);
  if (se >= 60) return null;
  if (m[1] != null && mi >= 60) return null;
  return h * 3600 + mi * 60 + se;
}

const TS = '(?:\\d{1,2}:)?\\d{1,3}:\\d{2}';
const BULLETS = '[\\s\\-–—•·*►▶▸→>|#]*';
// « 0:00 Intro », « [0:00] Intro », « (00:00) - Intro », « 0:00 - 1:30 Intro », « 1. 0:00 Intro »
const HEAD = new RegExp(`^${BULLETS}(?:\\d{1,2}[.)]\\s+)?[([]?\\s*(${TS})\\s*[)\\]]?(?:\\s*[-–—~à]\\s*[([]?${TS}[)\\]]?)?(?![\\d:])\\s*(.*)$`, 'u');
// « Intro - 0:00 », « Intro (0:00) »
const TAIL = new RegExp(`^(.*?\\S)[\\s\\-–—:|•·]*[([]?\\s*(${TS})\\s*[)\\]]?\\s*$`, 'u');

function cleanTitle(s: string): string {
  return s
    .replace(/^[\s\-–—:|•·.,;)\]]+/u, '')
    .replace(/[\s\-–—:|•·,;([]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Candidate { t: number; title: string; line: number }

/** Lignes de la description qui portent un horodatage en tête ou en fin de ligne. */
export function timestampLines(description: string): Candidate[] {
  const out: Candidate[] = [];
  description.split(/\r?\n/).forEach((raw, line) => {
    const s = raw.trim();
    if (!s || s.length > 200) return;
    let m = HEAD.exec(s);
    if (m) {
      const t = parseTimestamp(m[1]);
      if (t != null) out.push({ t, title: cleanTitle(m[2] ?? ''), line });
      return;
    }
    m = TAIL.exec(s);
    if (m && !/\d:\d{2}/.test(m[1])) {
      const t = parseTimestamp(m[2]);
      if (t != null) out.push({ t, title: cleanTitle(m[1]), line });
    }
  });
  return out;
}

/**
 * Extrait les chapitres. Comme YouTube, part du premier horodatage 0:00 et suit la liste tant qu'elle est croissante.
 * Sans 0:00, renvoie les horodatages triés (valid = false).
 */
export function parseChapters(description: string, durationSec?: number): ChaptersResult {
  const issues: string[] = [];
  let cands = timestampLines(description ?? '');
  if (durationSec != null && durationSec > 0) {
    const beyond = cands.filter(c => c.t >= durationSec);
    if (beyond.length) issues.push(`${beyond.length} horodatage(s) au-delà de la durée de la vidéo ignoré(s).`);
    cands = cands.filter(c => c.t < durationSec);
  }
  if (!cands.length) return { chapters: [], valid: false, issues };
  let list: Candidate[];
  const zero = cands.findIndex(c => c.t === 0);
  if (zero >= 0) {
    list = [cands[zero]];
    for (let i = zero + 1; i < cands.length; i++) {
      const prev = list[list.length - 1];
      // la liste doit rester croissante et groupée (au plus 2 lignes vides entre deux horodatages)
      if (cands[i].t > prev.t && cands[i].line - prev.line <= 3) list.push(cands[i]);
      else break;
    }
  } else {
    issues.push('Le premier horodatage doit être 0:00 pour que YouTube crée les chapitres.');
    const seen = new Set<number>();
    list = cands.slice().sort((a, b) => a.t - b.t).filter(c => (seen.has(c.t) ? false : (seen.add(c.t), true)));
  }
  const chapters: Chapter[] = list.map((c, i) => {
    const next = list[i + 1];
    const end = next ? next.t : durationSec != null && durationSec > c.t ? durationSec : c.t;
    return { index: i, start: c.t, end, title: c.title || `Chapitre ${i + 1}` };
  });
  if (chapters.length < 3) issues.push('Il faut au moins 3 chapitres.');
  const short = chapters.filter((c, i) => (i < chapters.length - 1 || durationSec != null) && c.end - c.start < 10);
  if (short.length) issues.push(`${short.length} chapitre(s) de moins de 10 s (minimum YouTube).`);
  const valid = zero >= 0 && chapters.length >= 3 && short.length === 0;
  return { chapters, valid, issues };
}

/** Chapitre en cours à l'instant t. */
export function chapterAt(chapters: Chapter[], t: number): Chapter | null {
  let found: Chapter | null = null;
  for (const c of chapters) { if (c.start <= t) found = c; else break; }
  return found && (t < found.end || found.index === chapters.length - 1) ? found : null;
}
