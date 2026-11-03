// Rétention d'audience : l'API YouTube Analytics v2 renvoie 100 points
// (elapsedVideoTimeRatio = 0,01 → 1,00) pour audienceWatchRatio et relativeRetentionPerformance.
// Prisme les interpole à la seconde — c'est une ESTIMATION entre deux mesures, signalée dans l'UI.

export interface RetentionPoint {
  /** Fraction écoulée de la vidéo (0,01 → 1). */
  ratio: number;
  /** audienceWatchRatio : part des vues encore présentes à cet instant (peut dépasser 1 : revisionnages). */
  watch: number;
  /** relativeRetentionPerformance : 0 → 1, 0,5 = médiane des vidéos de durée similaire. */
  relative: number | null;
}
export interface RetentionSample {
  t: number;
  watch: number;
  relative: number | null;
  /** true si un point réellement mesuré par l'API tombe sur cet échantillon (± ½ pas). */
  measured: boolean;
}
export type InterpMethod = 'linear' | 'monotone';

const findCol = (columns: string[], name: string) => columns.findIndex(c => c.toLowerCase() === name.toLowerCase());

/** Convertit la réponse Analytics (colonnes + lignes) en points triés et dédoublonnés. */
export function parseRetentionRows(columns: string[], rows: (string | number | null)[][]): RetentionPoint[] {
  const iR = findCol(columns, 'elapsedVideoTimeRatio');
  const iW = findCol(columns, 'audienceWatchRatio');
  const iP = findCol(columns, 'relativeRetentionPerformance');
  if (iR < 0 || iW < 0) throw new Error('Réponse YouTube Analytics inattendue : colonnes de rétention absentes.');
  const pts = rows
    .map(r => {
      const rel = iP >= 0 ? r[iP] : null;
      return {
        ratio: Number(r[iR]),
        watch: Number(r[iW]),
        relative: rel == null || rel === '' || !Number.isFinite(Number(rel)) ? null : Number(rel),
      };
    })
    .filter(p => Number.isFinite(p.ratio) && Number.isFinite(p.watch) && p.ratio > 0 && p.ratio <= 1 + 1e-9 && p.watch >= 0)
    .sort((a, b) => a.ratio - b.ratio);
  return pts.filter((p, i) => i === 0 || Math.abs(p.ratio - pts[i - 1].ratio) > 1e-9);
}

/** Pas d'échantillonnage : 1 s, plus fin pour les vidéos courtes (Shorts) afin de ne rien perdre des 100 points. */
export const defaultStep = (durationSec: number) => (durationSec >= 120 ? 1 : durationSec >= 30 ? 0.5 : 0.25);

/** Recherche dichotomique : plus grand i tel que xs[i] <= x. */
function segIndex(xs: number[], x: number): number {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  return lo;
}

/** Interpolation linéaire ; valeur maintenue (palier) avant le premier et après le dernier point. */
export function linearInterpolator(xs: number[], ys: number[]): (x: number) => number {
  if (xs.length !== ys.length || !xs.length) throw new Error('Interpolation : données vides.');
  if (xs.length === 1) return () => ys[0];
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    const last = xs.length - 1;
    if (x >= xs[last]) return ys[last];
    const i = segIndex(xs, x);
    const span = xs[i + 1] - xs[i];
    return span <= 0 ? ys[i] : ys[i] + ((x - xs[i]) / span) * (ys[i + 1] - ys[i]);
  };
}

/** Interpolation cubique monotone (Fritsch–Carlson) : passe par chaque point, sans dépassement. */
export function monotoneInterpolator(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n < 3) return linearInterpolator(xs, ys);
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(xs[i + 1] - xs[i]); m.push((ys[i + 1] - ys[i]) / (dx[i] || 1e-12)); }
  const c1: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    const m0 = m[i - 1], m1 = m[i];
    if (m0 * m1 <= 0) c1.push(0);
    else { const common = dx[i - 1] + dx[i]; c1.push((3 * common) / ((common + dx[i]) / m0 + (common + dx[i - 1]) / m1)); }
  }
  c1.push(m[n - 2]);
  const c2: number[] = [], c3: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const inv = 1 / (dx[i] || 1e-12), common = c1[i] + c1[i + 1] - 2 * m[i];
    c2.push((m[i] - c1[i] - common) * inv);
    c3.push(common * inv * inv);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    const i = segIndex(xs, x);
    const d = x - xs[i];
    return ys[i] + c1[i] * d + c2[i] * d * d + c3[i] * d * d * d;
  };
}

/**
 * Interpole les 100 points de l'API en une série régulière (1 point par seconde par défaut).
 * Le point de ratio r est placé à t = r × durée ; avant le premier point (0 → 1 % de la durée) la valeur est maintenue.
 */
export function interpolateRetention(points: RetentionPoint[], durationSec: number, opts: { method?: InterpMethod; step?: number } = {}): RetentionSample[] {
  if (!points.length || !(durationSec > 0)) return [];
  const step = opts.step && opts.step > 0 ? opts.step : defaultStep(durationSec);
  const xs = points.map(p => p.ratio * durationSec);
  const ws = points.map(p => p.watch);
  const fW = opts.method === 'monotone' ? monotoneInterpolator(xs, ws) : linearInterpolator(xs, ws);
  const relPts = points.filter(p => p.relative != null);
  const fR = relPts.length ? linearInterpolator(relPts.map(p => p.ratio * durationSec), relPts.map(p => p.relative as number)) : null;
  const n = Math.floor(durationSec / step + 1e-9);
  const times: number[] = [];
  for (let i = 0; i <= n; i++) times.push(Math.round(i * step * 1e6) / 1e6);
  if (times[times.length - 1] < durationSec - 1e-6) times.push(durationSec);
  const half = step / 2 + 1e-9;
  let k = 0;
  return times.map(t => {
    while (k < xs.length && xs[k] < t - half) k++;
    const measured = k < xs.length && Math.abs(xs[k] - t) <= half;
    return { t, watch: Math.max(0, fW(t)), relative: fR ? fR(t) : null, measured };
  });
}

/** Valeur interpolée dans une série régulière (lecture au survol, alignement des phrases). */
export function sampleAt(series: { t: number; watch: number }[], t: number): number {
  const n = series.length;
  if (!n) return NaN;
  if (t <= series[0].t) return series[0].watch;
  if (t >= series[n - 1].t) return series[n - 1].watch;
  const step = n > 1 ? series[1].t - series[0].t : 1;
  let i = Math.min(n - 2, Math.max(0, Math.floor((t - series[0].t) / step)));
  // la dernière case peut être plus courte (durée non multiple du pas)
  while (i < n - 2 && series[i + 1].t <= t) i++;
  while (i > 0 && series[i].t > t) i--;
  const a = series[i], b = series[i + 1];
  const span = b.t - a.t;
  return span <= 0 ? a.watch : a.watch + ((t - a.t) / span) * (b.watch - a.watch);
}
/** Échantillon le plus proche (index) — utilisé par le curseur. */
export function nearestIndex(series: { t: number }[], t: number): number {
  const n = series.length;
  if (!n) return -1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid].t <= t) lo = mid; else hi = mid; }
  return Math.abs(series[hi].t - t) < Math.abs(series[lo].t - t) ? hi : lo;
}

export interface RetentionSummary {
  /** Part de l'audience encore là à 30 s (ou 10 % de la durée pour une vidéo < 5 min). */
  early: { t: number; watch: number };
  middle: number;
  end: number;
  /** Moyenne de audienceWatchRatio ≈ % moyen regardé (aire sous la courbe / durée). */
  meanWatch: number;
  /** Moyenne de relativeRetentionPerformance (null si indisponible). */
  meanRelative: number | null;
  peak: { t: number; watch: number };
}
export function summarizeRetention(series: RetentionSample[], durationSec: number): RetentionSummary | null {
  if (!series.length) return null;
  const tEarly = durationSec >= 300 ? 30 : Math.max(1, durationSec * 0.1);
  let area = 0, rel = 0, relN = 0, peak = series[0];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    area += ((a.watch + b.watch) / 2) * (b.t - a.t);
    if (b.watch > peak.watch && b.t > tEarly) peak = b;
  }
  for (const s of series) if (s.relative != null) { rel += s.relative; relN++; }
  return {
    early: { t: tEarly, watch: sampleAt(series, tEarly) },
    middle: sampleAt(series, durationSec / 2),
    end: series[series.length - 1].watch,
    meanWatch: area / Math.max(1e-9, series[series.length - 1].t - series[0].t),
    meanRelative: relN ? rel / relN : null,
    peak: { t: peak.t, watch: peak.watch },
  };
}
