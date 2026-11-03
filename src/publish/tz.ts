// Fuseaux horaires (pure). YouTube Analytics découpe les jours en heure du Pacifique (America/Los_Angeles).
export const PT = 'America/Los_Angeles';
export const localTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}
export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number /* 0 = lundi … 6 = dimanche */ }
const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
export function zonedParts(ts: number, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ts))) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: WD[p.weekday] ?? 0 };
}
/** Décalage (minutes) du fuseau par rapport à UTC à l'instant donné (ex. -480 en PST). */
export function tzOffsetMinutes(ts: number, tz: string): number {
  const z = zonedParts(ts, tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}
/** Instant UTC correspondant à une date/heure murale dans un fuseau (gère les changements d'heure). */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ts = guess - tzOffsetMinutes(guess, tz) * 60000;
  const off2 = tzOffsetMinutes(ts, tz);
  ts = guess - off2 * 60000;
  return ts;
}
const p2 = (n: number) => String(n).padStart(2, '0');
/** « AAAA-MM-JJ » de l'instant dans le fuseau. */
export function dateKey(ts: number, tz: string): string { const z = zonedParts(ts, tz); return `${z.year}-${p2(z.month)}-${p2(z.day)}`; }
export const ptDate = (ts: number) => dateKey(ts, PT);
/** Minuit (heure du Pacifique) du jour donné, en ms UTC. */
export function ptMidnight(date: string): number { const [y, m, d] = date.split('-').map(Number); return zonedTimeToUtc(y, m, d, 0, 0, PT); }
/** Ajoute n jours calendaires à une date « AAAA-MM-JJ ». */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}
/** Premier minuit PT strictement après l'instant. */
export const nextPtMidnight = (ts: number) => ptMidnight(addDays(ptDate(ts), 1));
/** Fraction du jour PT déjà écoulée à l'instant (0 à minuit, 0,75 à 18 h). */
export function ptDayFraction(ts: number): number {
  const start = ptMidnight(ptDate(ts)); const end = nextPtMidnight(ts);
  return Math.min(1, Math.max(0, (ts - start) / (end - start)));
}
/** Liste des dates entre deux dates incluses. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}
export const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
export const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
