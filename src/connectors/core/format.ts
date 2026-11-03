// Formats d'affichage (fr-FR).
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

/** « à l'instant », « il y a 5 minutes », « hier »… */
export function timeAgo(ts?: number | null, now = Date.now()): string {
  if (!ts) return 'jamais';
  const s = Math.round((ts - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'à l’instant';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86_400 * 7) return rtf.format(Math.round(s / 86_400), 'day');
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const formatInt = (n: number) => new Intl.NumberFormat('fr-FR').format(Math.round(n));
export const formatCompact = (n: number) => new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** « 3 h 12 min », « 45 min », « 20 s ». */
export function formatDurationMs(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const h = Math.floor(totalMin / 60); const m = totalMin % 60;
  if (h >= 48) return `${Math.round(h / 24)} j`;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')} min` : ''}` : `${m} min`;
}

/** « 1:02:03 » / « 4:05 » pour une durée de vidéo. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export const formatBytes = (n?: number | null) => {
  if (n == null || !Number.isFinite(n)) return '';
  const u = ['o', 'Ko', 'Mo', 'Go']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 && i ? 1 : 0 })} ${u[i]}`;
};

/** Date locale AAAA-MM-JJ. */
export const localDayKey = (d: Date | number) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
