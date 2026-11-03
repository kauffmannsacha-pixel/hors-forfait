// Dates des propriétés : lecture tolérante (ISO, timestamp, objet {start,end}, jj/mm/aaaa…),
// écriture normalisée ('yyyy-MM-dd' ou "yyyy-MM-dd'T'HH:mm", plage {start,end}) et affichage FR.
import {
  addDays, differenceInCalendarDays, format, isValid, parse, parseISO, startOfDay,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import type { DateFormat } from './model';

export interface DateRange { start: Date; end: Date | null; hasTime: boolean }

const TEXT_PATTERNS = [
  'dd/MM/yyyy HH:mm', 'd/M/yyyy HH:mm', 'dd/MM/yyyy', 'd/M/yyyy', 'dd/MM/yy', 'dd-MM-yyyy', 'dd.MM.yyyy',
  'd MMMM yyyy HH:mm', 'd MMMM yyyy', 'd MMM yyyy', 'EEEE d MMMM yyyy', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd',
];

/** Convertit n'importe quelle entrée raisonnable en Date (ou null). */
export function parseDateInput(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isValid(v) ? v : null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const d = new Date(Math.abs(v) < 1e11 ? v * 1000 : v); // secondes (Stripe…) ou millisecondes
    return isValid(d) ? d : null;
  }
  if (typeof v === 'string') {
    const s = v.trim(); if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = parseISO(s); if (isValid(d)) return d; }
    if (/^\d{10,13}$/.test(s)) return parseDateInput(Number(s));
    const ref = new Date(2000, 0, 1);
    for (const p of TEXT_PATTERNS) {
      const d = parse(s, p, ref, { locale: fr });
      if (isValid(d)) return d;
    }
    const d = new Date(s);
    return isValid(d) ? d : null;
  }
  if (typeof v === 'object' && v && 'start' in v) return parseDateInput((v as { start: unknown }).start);
  return null;
}

const hasTimePart = (v: unknown): boolean => {
  if (typeof v === 'string') return /\d{1,2}:\d{2}/.test(v);
  if (typeof v === 'number' || v instanceof Date) {
    const d = parseDateInput(v); return !!d && (d.getHours() !== 0 || d.getMinutes() !== 0);
  }
  return false;
};

/** Lit une valeur de propriété date (simple ou plage). */
export function readDate(v: unknown): DateRange | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && !(v instanceof Date) && 'start' in (v as object)) {
    const o = v as { start?: unknown; end?: unknown };
    const start = parseDateInput(o.start); if (!start) return null;
    const end = parseDateInput(o.end);
    return { start, end: end && end.getTime() !== start.getTime() ? end : null, hasTime: hasTimePart(o.start) };
  }
  const start = parseDateInput(v);
  return start ? { start, end: null, hasTime: hasTimePart(v) } : null;
}

export const isoDay = (d: Date) => format(d, 'yyyy-MM-dd');
export const isoDateTime = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

/** Écrit une valeur date normalisée (null si pas de début). */
export function writeDate(start: Date | null, end?: Date | null, hasTime = false): string | { start: string; end: string } | null {
  if (!start || !isValid(start)) return null;
  const f = hasTime ? isoDateTime : isoDay;
  if (end && isValid(end) && end.getTime() !== start.getTime()) {
    const [a, b] = end < start ? [end, start] : [start, end];
    return { start: f(a), end: f(b) };
  }
  return f(start);
}

/** Décale une valeur date de n jours (garde la plage et l'heure). */
export function shiftDate(v: unknown, days: number): ReturnType<typeof writeDate> {
  const r = readDate(v); if (!r) return null;
  return writeDate(addDays(r.start, days), r.end ? addDays(r.end, days) : null, r.hasTime);
}

const PATTERNS: Record<Exclude<DateFormat, 'relative'>, string> = {
  short: 'd MMM yyyy', full: 'd MMMM yyyy', dmy: 'dd/MM/yyyy', mdy: 'MM/dd/yyyy', iso: 'yyyy-MM-dd',
};

export function formatDay(d: Date, fmt: DateFormat = 'short', now = new Date()): string {
  if (fmt === 'relative') {
    const diff = differenceInCalendarDays(d, now);
    if (diff === 0) return "Aujourd'hui";
    if (diff === 1) return 'Demain';
    if (diff === -1) return 'Hier';
    if (diff > 1 && diff < 7) return format(d, 'EEEE', { locale: fr }).replace(/^./, c => c.toUpperCase());
    if (diff < -1 && diff > -7) return `Il y a ${-diff} jours`;
    return format(d, PATTERNS.short, { locale: fr });
  }
  return format(d, PATTERNS[fmt], { locale: fr });
}
export const formatTime = (d: Date, tf: '24h' | '12h' = '24h') => format(d, tf === '12h' ? 'h:mm a' : 'HH:mm', { locale: fr });

/** Texte d'affichage d'une date (plage incluse). */
export function formatDateRange(r: DateRange | null, fmt: DateFormat = 'short', tf: '24h' | '12h' = '24h', now = new Date()): string {
  if (!r) return '';
  const one = (d: Date) => formatDay(d, fmt, now) + (r.hasTime ? ' ' + formatTime(d, tf) : '');
  return r.end ? `${one(r.start)} → ${one(r.end)}` : one(r.start);
}

export const formatTimestamp = (ms: number, fmt: DateFormat = 'short', tf: '24h' | '12h' = '24h') => {
  const d = new Date(ms); return isValid(d) ? `${formatDay(d, fmt)} ${formatTime(d, tf)}` : '';
};

export { startOfDay };
