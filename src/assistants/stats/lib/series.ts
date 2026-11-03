// Séries temporelles de vues : instantanés horaires (enregistrés par Prisme), séries journalières
// (YouTube Analytics, jours en heure du Pacifique) et enveloppe des vidéos précédentes.

export interface Snapshot { t: number; views: number; likes?: number; comments?: number }
export interface HourPoint {
  /** Heures écoulées depuis la publication. */
  h: number;
  /** Vues cumulées à cette heure (null = inconnu : Prisme n'était pas ouvert). */
  cum: number | null;
  /** Vues gagnées pendant l'heure écoulée. */
  delta: number | null;
  /** Un instantané réel existe à ± 10 min. */
  measured: boolean;
}
export interface DayPoint { d: number; date: string; views: number | null; cum: number | null }
export interface EnvelopePoint { n: number; min: number; p25: number; median: number; p75: number; max: number }

/** Quantile (interpolation linéaire, type 7) d'un tableau TRIÉ. */
export function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export const medianOf = (values: number[]) => quantileSorted(values.slice().sort((a, b) => a - b), 0.5);

/** Enveloppe point par point (min, quartiles, médiane, max) d'un ensemble de séries ; ignore les valeurs absentes. */
export function envelope(series: (number | null | undefined)[][], length: number, minN = 2): (EnvelopePoint | null)[] {
  const out: (EnvelopePoint | null)[] = [];
  for (let i = 0; i < length; i++) {
    const vals = series.map(s => s[i]).filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
    out.push(vals.length < minN ? null : {
      n: vals.length, min: vals[0], max: vals[vals.length - 1],
      p25: quantileSorted(vals, 0.25), median: quantileSorted(vals, 0.5), p75: quantileSorted(vals, 0.75),
    });
  }
  return out;
}

// ── Dates (YouTube Analytics découpe les jours en heure du Pacifique) ──
export const PT_TZ = 'America/Los_Angeles';
const dtfCache = new Map<string, Intl.DateTimeFormat>();
/** Date « AAAA-MM-JJ » d'un instant dans un fuseau donné. */
export function dateInTz(ms: number, tz = PT_TZ): string {
  let f = dtfCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); dtfCache.set(tz, f); }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const ymdToUtc = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export function addDays(ymd: string, n: number): string {
  return new Date(ymdToUtc(ymd) + n * 86_400_000).toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86_400_000);

// ── Vues par heure (instantanés) ──
/**
 * Vues cumulées heure par heure depuis la publication, à partir des instantanés.
 * Ancre : 0 vue à l'instant de publication. On n'interpole qu'entre deux mesures espacées de ≤ maxGapH heures :
 * au-delà (Prisme fermé), la valeur reste inconnue plutôt que d'inventer une courbe.
 */
export function hourlySeries(snaps: Snapshot[], publishedMs: number, hours = 48, opts: { now?: number; maxGapH?: number } = {}): HourPoint[] {
  const now = opts.now ?? Date.now();
  const maxGap = (opts.maxGapH ?? 2) * 3_600_000;
  const anchors = [{ t: publishedMs, views: 0 }, ...snaps.filter(s => s.t >= publishedMs && Number.isFinite(s.views)).sort((a, b) => a.t - b.t)];
  const out: HourPoint[] = [];
  let j = 0;
  for (let h = 0; h <= hours; h++) {
    const T = publishedMs + h * 3_600_000;
    let cum: number | null = null;
    if (T <= now + 60_000) {
      while (j < anchors.length - 2 && anchors[j + 1].t <= T) j++;
      const a = anchors[j], b = anchors[j + 1];
      const near = (x: { t: number } | undefined) => !!x && Math.abs(x.t - T) <= 10 * 60_000;
      const lastA = anchors[anchors.length - 1];
      if (h === 0) cum = 0;
      else if (near(a)) cum = a.views;
      else if (b && near(b)) cum = b.views;
      else if (b && T > a.t && T < b.t && b.t - a.t <= maxGap) cum = a.views + ((T - a.t) / (b.t - a.t)) * (b.views - a.views);
      else if (near(lastA)) cum = lastA.views;
    }
    const measured = snaps.some(s => Math.abs(s.t - T) <= 10 * 60_000);
    const prev = out[out.length - 1];
    out.push({ h, cum: cum == null ? null : Math.round(cum), delta: prev && prev.cum != null && cum != null ? Math.max(0, Math.round(cum) - prev.cum) : null, measured });
  }
  return out;
}

// ── Vues par jour (Analytics) ──
/** Série journalière alignée sur J0 = jour de publication (heure du Pacifique). Jours sans ligne avant la dernière date connue = 0 vue. */
export function dailySeries(rows: { date: string; views: number }[], publishedYmd: string, horizon: number): DayPoint[] {
  const map = new Map(rows.map(r => [r.date, r.views]));
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const out: DayPoint[] = [];
  let cum = 0;
  for (let d = 0; d <= horizon; d++) {
    const date = addDays(publishedYmd, d);
    const v = map.has(date) ? map.get(date)! : last && date <= last ? 0 : null;
    if (v == null) { out.push({ d, date, views: null, cum: null }); continue; }
    cum += v;
    out.push({ d, date, views: v, cum });
  }
  // Après le premier jour inconnu, tout est inconnu (pas de cumul troué).
  const firstNull = out.findIndex(p => p.views == null);
  if (firstNull >= 0) for (let i = firstNull; i < out.length; i++) { out[i].views = null; out[i].cum = null; }
  return out;
}

/** Vues moyennes par jour depuis la publication (données publiques). */
export const viewsPerDay = (views: number, publishedAt: string, now = Date.now()) =>
  views / Math.max(1 / 24, (now - new Date(publishedAt).getTime()) / 86_400_000);
