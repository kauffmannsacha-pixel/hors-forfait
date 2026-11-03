// Formatage français (nombres, durées, dates) partagé par l'analyseur de stats.
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const nfCompact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const nfCache = new Map<number, Intl.NumberFormat>();
const nfd = (digits: number) => {
  let f = nfCache.get(digits);
  if (!f) { f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: digits }); nfCache.set(digits, f); }
  return f;
};
const ok = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
export const DASH = '—';
const MINUS = '−';

/** 12 345 */
export const fmtInt = (n: number | null | undefined) => (ok(n) ? nf0.format(Math.round(n)).replace('-', MINUS) : DASH);
/** 12,3 k / 1,2 M (en entier sous 10 000) */
export const fmtCompact = (n: number | null | undefined) =>
  !ok(n) ? DASH : Math.abs(n) < 10_000 ? fmtInt(n) : nfCompact.format(n).replace('-', MINUS);
/** 3,14 */
export const fmtNum = (n: number | null | undefined, digits = 1) => (ok(n) ? nfd(digits).format(n).replace('-', MINUS) : DASH);
/** ratio 0,452 → « 45,2 % » */
export const fmtPct = (ratio: number | null | undefined, digits = 1) => (ok(ratio) ? `${fmtNum(ratio * 100, digits)} %` : DASH);
/** Points de pourcentage signés : « −4,2 pts » / « +1 pt » */
export const fmtPts = (pts: number, digits = 1) => {
  const a = Math.abs(pts);
  const s = pts > 0 ? '+' : pts < 0 ? MINUS : '';
  const unit = Number(a.toFixed(digits)) >= 2 ? 'pts' : 'pt';
  return `${s}${fmtNum(a, digits)} ${unit}`;
};
/** 0:05 / 4:05 / 1:02:03 */
export function fmtClock(sec: number | null | undefined): string {
  if (!ok(sec)) return DASH;
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
/** Horodatage précis au dixième pour les vidéos courtes : 0:04,5 */
export function fmtClockPrecise(sec: number, durationSec: number): string {
  if (durationSec >= 120 || !ok(sec)) return fmtClock(sec);
  const base = fmtClock(sec);
  const tenth = Math.floor((sec % 1) * 10 + 1e-6);
  return `${base},${tenth}`;
}
/** 12 min 05 s / 1 h 02 min / 45 s */
export function fmtDuration(sec: number | null | undefined): string {
  if (!ok(sec)) return DASH;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}
export const fmtMoney = (n: number | null | undefined, currency = 'USD') =>
  ok(n) ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n) : DASH;
const dShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const dTime = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (d: string | number | Date | null | undefined) => {
  if (d == null) return DASH;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? DASH : dShort.format(x);
};
export const fmtDateTime = (d: string | number | Date) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? DASH : dTime.format(x);
};
/** « il y a 5 min », « il y a 3 h », « il y a 2 j » */
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
/** Âge lisible depuis la publication : « 5 h », « 3 j », « 2 mois » */
export function fmtAge(publishedAt: string, now = Date.now()): string {
  const h = (now - new Date(publishedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(h)) return DASH;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)} j`;
  if (d < 730) return `${Math.round(d / 30.44)} mois`;
  return `${fmtNum(d / 365.25, 1)} ans`;
}
let regionNames: Intl.DisplayNames | null = null;
/** Code ISO 3166-1 → nom français (ZZ = inconnu). */
export function countryName(code: string): string {
  if (!code || code === 'ZZ') return 'Pays inconnu';
  try {
    regionNames ??= new Intl.DisplayNames(['fr'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch { return code; }
}
/** Tronque proprement un texte à n caractères (mot entier si possible). */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
