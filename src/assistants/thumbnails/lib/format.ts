// Formats français (vues, durées, dates relatives).
import { formatDistanceToNowStrict } from 'date-fns';
import { fr } from 'date-fns/locale';

const dec = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '').replace('.', ','));
/** 1 234 567 → « 1,2 M » ; 12 345 → « 12 k ». */
export function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return `${dec(n / 1e9)} Md`;
  if (a >= 1e6) return `${dec(n / 1e6)} M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)} k`;
  if (a >= 1e3) return `${dec(n / 1e3)} k`;
  return Math.round(n).toString();
}
/** « 1,2 M de vues », « 34 k vues », « 950 vues ». */
export function formatViews(n: number): string {
  const s = formatNum(n);
  return /\s(M|Md)$/.test(s) ? `${s} de vues` : `${s} vue${n > 1 ? 's' : ''}`;
}
/** 754 → « 12:34 » ; 3723 → « 1:02:03 ». */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
export function formatAgo(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatDistanceToNowStrict(d, { locale: fr, addSuffix: true });
}
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits).replace('.', ',')} %`;
export const ratioLabel = (r?: number) => (r == null || !Number.isFinite(r) ? '–' : `×${r >= 10 ? Math.round(r) : r.toFixed(1).replace('.', ',')}`);
export const fr1 = (v: number) => v.toFixed(1).replace('.', ',');
