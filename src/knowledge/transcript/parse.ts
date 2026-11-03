// Parsing des transcriptions (pur, testé) : SRT, WebVTT (y compris sous-titres auto « déroulants »),
// texte horodaté ou brut, et normalisation des réponses JSON/texte d'un outil MCP « transcript ».
import type { TranscriptSegment } from '../api';

export type TranscriptFormat = 'srt' | 'vtt' | 'txt' | 'json';
export interface ParsedTranscript { segments: TranscriptSegment[]; timed: boolean; format: TranscriptFormat; language?: string }

const WORDS_PER_SEC = 2.5; // ~150 mots/min (estimation pour les textes sans horodatage)
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** « 01:02:03,456 », « 02:03.4 », « 1:02 », « 75 », « 75.5 », « 1h02m03s », « 2m30s » → secondes (null si illisible). */
export function parseTimestamp(input: string): number | null {
  const t = input.trim();
  let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t);
  if (m) return (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +('0.' + m[4].padEnd(3, '0')) : 0);
  m = /^(?:(\d+)h)?\s*(?:(\d+)m(?:in)?)?\s*(?:(\d+(?:[.,]\d+)?)s)?$/i.exec(t);
  if (m && (m[1] || m[2] || m[3])) return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + +(m[3] ?? '0').replace(',', '.');
  m = /^(\d+(?:[.,]\d+)?)$/.exec(t);
  if (m) return +m[1].replace(',', '.');
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"' };
/** Nettoie un texte de sous-titre : balises, styles ASS, entités HTML, bruitages, espaces. */
export function cleanCaptionText(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\\[^}]*\}/g, ' ')
    .replace(/&(#?\w+);/g, (all, e: string) => ENTITIES[e.toLowerCase()] ?? (/^#\d+$/.test(e) ? String.fromCharCode(+e.slice(1)) : all))
    .replace(/\[(?:music|musique|applause|applaudissements|laughter|rires?|silence|bruit|noise|♪+)\]/gi, ' ')
    .replace(/^\s*(?:>>|-)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TIME = String.raw`(?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?`;
const CUE_LINE = new RegExp(String.raw`^\s*(${TIME})\s*-->\s*(${TIME})`);

/** Cues SRT/VTT (tolérant : numéros, identifiants, NOTE/STYLE, lignes vides manquantes). */
function parseCues(src: string): { start: number; end: number; lines: string[] }[] {
  const lines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: { start: number; end: number; lines: string[] }[] = [];
  let cur: { start: number; end: number; lines: string[] } | null = null;
  let afterBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = CUE_LINE.exec(line);
    if (m) {
      if (cur) cues.push(cur);
      cur = { start: parseTimestamp(m[1]) ?? 0, end: parseTimestamp(m[2]) ?? 0, lines: [] };
      afterBlank = false;
      continue;
    }
    if (!cur) continue;                               // en-tête WEBVTT, métadonnées…
    if (!line.trim()) { afterBlank = true; continue; }
    if (afterBlank) continue;                         // identifiant de cue / bloc NOTE avant la prochaine ligne de temps
    if (/^\d+$/.test(line.trim()) && CUE_LINE.test(lines[i + 1] ?? '')) continue; // numéro SRT sans ligne vide
    cur.lines.push(line);
  }
  if (cur) cues.push(cur);
  return cues;
}

/** Cues → segments, en supprimant les répétitions des sous-titres automatiques « déroulants ». */
function cuesToSegments(cues: { start: number; end: number; lines: string[] }[]): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  const recent: string[] = [];
  for (const c of cues) {
    const fresh: string[] = [];
    for (const raw of c.lines) {
      const txt = cleanCaptionText(raw);
      if (!txt) continue;
      if (recent.includes(txt) || fresh.includes(txt)) continue;
      fresh.push(txt);
    }
    for (const f of fresh) { recent.push(f); if (recent.length > 3) recent.shift(); }
    if (!fresh.length) continue;
    segs.push({ start: r3(c.start), dur: r3(Math.max(0, c.end - c.start)), text: fresh.join(' ') });
  }
  return segs;
}

export const parseSrt = (src: string): TranscriptSegment[] => cuesToSegments(parseCues(src));
export const parseVtt = (src: string): TranscriptSegment[] => cuesToSegments(parseCues(src));

const LEAD_TS = /^\s*[[(]?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*(?:[-–—|:]\s*)?(.*)$/;

/** Texte : lignes horodatées (« 0:00 », « [00:01:02] texte »…) ou texte brut (horodatage estimé). */
export function parseTxt(src: string): { segments: TranscriptSegment[]; timed: boolean } {
  const lines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const stamped = lines.filter(l => LEAD_TS.test(l)).length;
  if (lines.length && stamped >= Math.max(2, lines.length * 0.3)) {
    const segs: { start: number; text: string }[] = [];
    for (const l of lines) {
      const m = LEAD_TS.exec(l);
      if (m) segs.push({ start: parseTimestamp(m[1]) ?? 0, text: cleanCaptionText(m[2]) });
      else if (segs.length) segs[segs.length - 1].text = (segs[segs.length - 1].text + ' ' + cleanCaptionText(l)).trim();
    }
    const kept = segs.filter(s => s.text).sort((a, b) => a.start - b.start);
    return {
      timed: true,
      segments: kept.map((s, i) => {
        const next = kept[i + 1]?.start;
        const est = s.text.split(/\s+/).length / WORDS_PER_SEC;
        return { start: r3(s.start), dur: r3(next != null ? Math.max(0, next - s.start) : est), text: s.text };
      }),
    };
  }
  // Texte brut : phrases regroupées par ~25 mots, temps estimé.
  const words = cleanCaptionText(lines.join(' ')).split(/\s+/).filter(Boolean);
  const segments: TranscriptSegment[] = [];
  let buf: string[] = []; let t = 0;
  const push = () => { if (!buf.length) return; const dur = buf.length / WORDS_PER_SEC; segments.push({ start: r3(t), dur: r3(dur), text: buf.join(' ') }); t += dur; buf = []; };
  for (const w of words) { buf.push(w); if ((buf.length >= 12 && /[.!?…]$/.test(w)) || buf.length >= 30) push(); }
  push();
  return { segments, timed: false };
}

/** Détecte le format et parse. */
export function parseTranscriptText(src: string): ParsedTranscript {
  const s = src.replace(/^﻿/, '').trim();
  if (/^[[{]/.test(s)) {
    let json: unknown; let isJson = false;
    try { json = JSON.parse(s); isJson = true; } catch { /* pas du JSON */ }
    if (isJson) return normalizeTranscriptPayload(json) ?? { segments: [], timed: false, format: 'json' };
  }
  if (/-->/.test(s) && CUE_LINE.test(s.split('\n').find(l => l.includes('-->')) ?? '')) {
    const vtt = /^WEBVTT/.test(s);
    return { segments: vtt ? parseVtt(s) : parseSrt(s), timed: true, format: vtt ? 'vtt' : 'srt' };
  }
  const t = parseTxt(s);
  return { segments: t.segments, timed: t.timed, format: 'txt' };
}

// ── Réponses d'outils MCP (formats variés) ───────────────────
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const TEXT_KEYS = ['text', 'content', 'caption', 'utf8', 'value', 'line', 'snippet', 'transcript', 'sentence'];
const START_KEYS = ['start', 'start_time', 'startTime', 'start_seconds', 'startSeconds', 'begin', 'from', 'offset', 't', 'time', 'timestamp', 'ts', 'tStartMs', 'start_ms', 'startMs', 'offset_ms', 'offsetMs'];
const DUR_KEYS = ['dur', 'duration', 'duration_ms', 'durationMs', 'dDurationMs', 'length'];
const END_KEYS = ['end', 'end_time', 'endTime', 'end_seconds', 'end_ms', 'endMs', 'to', 'stop'];

function textOf(o: Obj): string | null {
  for (const k of TEXT_KEYS) if (typeof o[k] === 'string') return o[k] as string;
  if (Array.isArray(o.segs)) return (o.segs as unknown[]).map(x => (isObj(x) && typeof x.utf8 === 'string' ? x.utf8 : '')).join('');
  return null;
}
function numField(o: Obj, keys: string[]): { v: number; key: string } | null {
  for (const k of keys) {
    const raw = o[k];
    if (typeof raw === 'number' && isFinite(raw)) return { v: raw, key: k };
    if (typeof raw === 'string' && raw.trim()) { const p = parseTimestamp(raw); if (p != null) return { v: p, key: k + (/:/.test(raw) ? ':clock' : '') }; }
  }
  return null;
}
const isMsKey = (k: string) => /ms$|Ms$|_ms|MS/.test(k);

/** Tableau d'objets {texte, temps} le plus fourni trouvé dans la réponse. */
function findSegmentArray(v: unknown, depth = 0): Obj[] | null {
  if (depth > 6) return null;
  let best: Obj[] | null = null;
  const consider = (arr: Obj[]) => { if (!best || arr.length > best.length) best = arr; };
  if (Array.isArray(v)) {
    const objs = v.filter(isObj);
    if (objs.length && objs.length >= v.length * 0.6) {
      const withText = objs.filter(o => textOf(o) != null).length;
      const withTime = objs.filter(o => numField(o, START_KEYS)).length;
      if (withText >= objs.length * 0.6 && withTime >= objs.length * 0.6) consider(objs);
    }
    for (const x of v.slice(0, 50)) { const r = findSegmentArray(x, depth + 1); if (r) consider(r); }
  } else if (isObj(v)) {
    for (const x of Object.values(v)) { const r = findSegmentArray(x, depth + 1); if (r) consider(r); }
  }
  return best;
}
function findString(v: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  if (isObj(v)) for (const k of keys) if (typeof v[k] === 'string' && (v[k] as string).trim()) return v[k] as string;
  for (const x of Object.values(v as Obj)) { const r = findString(x, keys, depth + 1); if (r) return r; }
  return null;
}
function longestString(v: unknown, depth = 0): string {
  if (typeof v === 'string') return v;
  if (depth > 6 || !v || typeof v !== 'object') return '';
  let best = '';
  for (const x of Object.values(v as Obj)) { const s = longestString(x, depth + 1); if (s.length > best.length) best = s; }
  return best;
}

/** Erreur explicite renvoyée par un serveur (ex. crédits insuffisants). */
export function payloadError(v: unknown): string | null {
  if (!isObj(v)) return null;
  const status = typeof v.status === 'number' ? v.status : undefined;
  const err = v.error;
  if (status != null && status >= 400) return (typeof v.message === 'string' ? v.message : `erreur ${status}`) + (typeof v.code === 'string' ? ` (${v.code})` : '');
  if (typeof err === 'string' && err) return err;
  if (isObj(err) && typeof err.message === 'string') return err.message;
  return null;
}

/** Normalise une réponse (objet JSON ou texte) en segments horodatés. null = aucune transcription exploitable. */
export function normalizeTranscriptPayload(payload: unknown): ParsedTranscript | null {
  if (typeof payload === 'string') {
    const s = payload.trim();
    if (!s) return null;
    if (/^[[{]/.test(s)) { try { return normalizeTranscriptPayload(JSON.parse(s)); } catch { /* texte */ } }
    const p = parseTranscriptText(s);
    return p.segments.length ? p : null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const language = findString(payload, ['language', 'lang', 'language_code', 'languageCode', 'lang_code']) ?? undefined;
  const arr = findSegmentArray(payload);
  if (arr) {
    const rows = arr.map(o => {
      const st = numField(o, START_KEYS)!;
      const du = numField(o, DUR_KEYS); const en = numField(o, END_KEYS);
      return { o, start: st, dur: du, end: en, text: cleanCaptionText(textOf(o) ?? '') };
    });
    // Unité : clé en ms, ou écart médian entre débuts ≥ 250 (impossible en secondes pour des sous-titres) → millisecondes.
    const starts = rows.map(r => r.start.v);
    const deltas = starts.slice(1).map((s, i) => s - starts[i]).filter(d => d > 0).sort((a, b) => a - b);
    const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
    const anyClock = rows.some(r => r.start.key.endsWith(':clock'));
    const startMs = !anyClock && (rows.some(r => isMsKey(r.start.key)) || median >= 250);
    const segs: TranscriptSegment[] = [];
    for (const r of rows) {
      if (!r.text) continue;
      const start = startMs && !r.start.key.endsWith(':clock') ? r.start.v / 1000 : r.start.v;
      let dur = 0;
      if (r.dur) dur = r.dur.key.endsWith(':clock') ? r.dur.v : (isMsKey(r.dur.key) || (startMs && !anyClock) ? r.dur.v / 1000 : r.dur.v);
      else if (r.end) { const end = r.end.key.endsWith(':clock') ? r.end.v : (isMsKey(r.end.key) || startMs ? r.end.v / 1000 : r.end.v); dur = Math.max(0, end - start); }
      segs.push({ start: r3(start), dur: r3(dur), text: r.text });
    }
    segs.sort((a, b) => a.start - b.start);
    for (let i = 0; i < segs.length; i++) if (!segs[i].dur && segs[i + 1]) segs[i].dur = r3(Math.max(0, segs[i + 1].start - segs[i].start));
    if (segs.length) return { segments: segs, timed: true, format: 'json', language };
  }
  // Pas de tableau : un champ texte (transcription en bloc, SRT/VTT/texte horodaté).
  const blob = findString(payload, ['transcript', 'text', 'content', 'srt', 'vtt', 'captions', 'body']) ?? longestString(payload);
  if (blob && blob.trim().length > 20) {
    const p = parseTranscriptText(blob);
    if (p.segments.length) return { ...p, language: p.language ?? language };
  }
  return null;
}
