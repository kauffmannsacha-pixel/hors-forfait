// Dates des mentions (@aujourd'hui, @demain, @12/11…) : analyse et affichage en français. Fonctions pures.
import { addDays, addWeeks, addMonths, differenceInCalendarDays, format, isValid, startOfDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { normalize } from './fuzzy';

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

/** AAAA-MM-JJ (date locale). */
export const toISODate = (d: Date) => format(d, 'yyyy-MM-dd');
export const fromISODate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };

/**
 * Interprète une requête de date en français : « aujourd'hui », « demain », « hier », « après-demain »,
 * « lundi », « dans 3 jours », « dans 2 semaines », « 12/11 », « 12/11/2026 », « 2026-11-12 », « 12 novembre (2026) ».
 */
export function parseDateQuery(raw: string, now = new Date()): Date | null {
  const q = normalize(raw).trim().replace(/\s+/g, ' ');
  if (!q) return null;
  const today = startOfDay(now);
  if (/^(aujourd'?hui|aujourdhui|auj)$/.test(q)) return today;
  if (q === 'demain') return addDays(today, 1);
  if (/^apres[- ]?demain$/.test(q)) return addDays(today, 2);
  if (q === 'hier') return addDays(today, -1);
  if (/^avant[- ]?hier$/.test(q)) return addDays(today, -2);
  const wd = WEEKDAYS.findIndex(w => w === q || (q.length >= 3 && w.startsWith(q)) || q === w + ' prochain');
  if (wd >= 0) { let delta = (wd - today.getDay() + 7) % 7; if (delta === 0) delta = 7; return addDays(today, delta); }
  let m = q.match(/^dans (\d+) (jour|jours|semaine|semaines|mois)$/);
  if (m) { const n = Number(m[1]); return m[2].startsWith('jour') ? addDays(today, n) : m[2].startsWith('semaine') ? addWeeks(today, n) : addMonths(today, n); }
  m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return valid(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), Number(m[3]));
  m = q.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.getFullYear();
    return valid(new Date(y, Number(m[2]) - 1, Number(m[1])), Number(m[1]));
  }
  m = q.match(/^(\d{1,2})(?:er)? ([a-z]+)\.?(?: (\d{4}))?$/);
  if (m) {
    const mi = MONTHS.findIndex(mo => mo.startsWith(m![2]) && m![2].length >= 3);
    if (mi >= 0) return valid(new Date(m[3] ? Number(m[3]) : today.getFullYear(), mi, Number(m[1])), Number(m[1]));
  }
  return null;
}
const valid = (d: Date, day: number) => (isValid(d) && d.getDate() === day ? d : null);

/** Libellé d'une date : « Aujourd'hui », « Demain », « Hier », « lundi 10 novembre », « 3 janvier 2027 ». */
export function formatMentionDate(d: Date, now = new Date()): string {
  const diff = differenceInCalendarDays(d, now);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  if (diff > 1 && diff < 7) return format(d, 'EEEE d MMMM', { locale: fr });
  return format(d, d.getFullYear() === now.getFullYear() ? 'd MMMM' : 'd MMMM yyyy', { locale: fr });
}

/** Libellé d'un rappel : « Demain 09:00 », « 12 novembre 18:30 ». */
export const formatReminder = (ts: number, now = new Date()) => `${formatMentionDate(new Date(ts), now)} ${format(new Date(ts), 'HH:mm')}`;

/** Date longue pour l'historique : « 3 novembre 2026 à 14:05 ». */
export const formatDateTime = (ts: number) => format(new Date(ts), "d MMMM yyyy 'à' HH:mm", { locale: fr });
export const formatTime = (ts: number) => format(new Date(ts), 'HH:mm');
export const formatDay = (ts: number) => format(new Date(ts), 'EEEE d MMMM yyyy', { locale: fr });
