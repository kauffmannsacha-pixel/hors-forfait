// Détection automatique des chutes et des pics de rétention.
// Méthode : série lissée (moyenne mobile centrée, fenêtre ≈ résolution de l'API = 1 % de la durée),
// dérivée centrée, puis seuils robustes (médiane ± k × MAD) calculés sur le « corps » de la vidéo
// (hors intro et hors écran de fin, qui ont leurs propres annotations).

export type EventKind = 'drop' | 'spike' | 'intro' | 'outro';
export interface RetentionEvent {
  id: string;
  kind: EventKind;
  /** Début et fin de la zone (s). */
  start: number;
  end: number;
  /** Instant le plus marqué : pente la plus forte (chute) ou sommet (pic). */
  at: number;
  /** Rétention (audienceWatchRatio) à l'instant `at`. */
  value: number;
  /** Variation sur la zone, en points de pourcentage (ex. −4,2) — lisible directement sur la courbe. */
  deltaPts: number;
  /** Variation au-delà de l'érosion normale de la vidéo sur la même durée (sert au tri et aux seuils). */
  excessPts: number;
  /** Écart à la pente typique, en multiples de l'écart robuste (intensité). */
  zScore: number;
}
export interface DetectOptions {
  /** k : seuil en écarts robustes (2 = sensible, 3 = normal, 4 = strict). */
  sensitivity?: number;
  /** Variation minimale retenue pour une chute (points). */
  minDropPts?: number;
  /** Hausse minimale retenue pour un pic (points). */
  minSpikePts?: number;
  maxDrops?: number;
  maxSpikes?: number;
}
export const SENSITIVITY = { basse: 4, normale: 3, haute: 2 } as const;

/** Moyenne mobile centrée (fenêtre 2·half+1, tronquée aux bords). */
export function movingAverage(values: number[], half: number): number[] {
  const n = values.length;
  if (half <= 0 || n === 0) return values.slice();
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + values[i];
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}
/** Dérivée centrée par seconde, sur ± half échantillons. */
export function centeredSlope(values: number[], step: number, half: number): number[] {
  const n = values.length;
  const h = Math.max(1, half);
  return values.map((_, i) => {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    return b === a ? 0 : (values[b] - values[a]) / ((b - a) * step);
  });
}
export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Écart absolu médian (normalisé pour estimer un écart-type : × 1,4826). */
export const robustSigma = (values: number[], med = median(values)) => 1.4826 * median(values.map(v => Math.abs(v - med)));

/** Zones d'intro (accroche) et de fin (écran de fin) exclues du calcul des seuils. */
export function introOutro(durationSec: number) {
  const intro = Math.min(30, Math.max(Math.min(3, durationSec * 0.2), durationSec * 0.1));
  const outro = Math.min(20, Math.max(Math.min(3, durationSec * 0.1), durationSec * 0.05));
  return { introEnd: intro, outroStart: Math.max(intro, durationSec - outro) };
}

interface Run { a: number; b: number }
function runs(flags: boolean[], idx: number[], maxGap: number): Run[] {
  const out: Run[] = [];
  let cur: Run | null = null;
  for (const i of idx) {
    if (!flags[i]) continue;
    if (cur && i - cur.b <= maxGap + 1) cur.b = i;
    else { if (cur) out.push(cur); cur = { a: i, b: i }; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Détecte et annote les événements d'une série de rétention régulière (t croissant, pas constant).
 * Toujours renvoie l'événement « intro » ; « outro » si la fin perd au moins minDropPts.
 */
export function detectEvents(series: { t: number; watch: number }[], durationSec: number, opts: DetectOptions = {}): RetentionEvent[] {
  const n = series.length;
  if (n < 5 || !(durationSec > 0)) return [];
  const k = opts.sensitivity ?? SENSITIVITY.normale;
  const minDrop = opts.minDropPts ?? 1;
  const minSpike = opts.minSpikePts ?? 0.6;
  const step = series[1].t - series[0].t || 1;
  const resolution = Math.max(step, durationSec / 100); // 1 point API = 1 % de la durée
  const half = Math.max(1, Math.round(resolution / step));
  const y = series.map(s => s.watch);
  const ys = movingAverage(y, half);
  const d = centeredSlope(ys, step, half);
  const { introEnd, outroStart } = introOutro(durationSec);
  const at = (i: number) => series[i].t;
  const iOf = (t: number) => Math.min(n - 1, Math.max(0, Math.round((t - series[0].t) / step)));
  const events: RetentionEvent[] = [];

  // Intro : perte entre le début et la fin de l'accroche.
  const iIntro = iOf(introEnd);
  const introDelta = (y[iIntro] - y[0]) * 100;
  events.push({ id: 'intro', kind: 'intro', start: 0, end: at(iIntro), at: at(iIntro), value: y[iIntro], deltaPts: introDelta, excessPts: introDelta, zScore: 0 });

  // Corps : seuils robustes sur la pente.
  const body: number[] = [];
  for (let i = 0; i < n; i++) if (at(i) >= introEnd && at(i) <= outroStart) body.push(i);
  if (body.length >= 5) {
    const first = body[0], last = body[body.length - 1];
    const slopes = body.map(i => d[i]);
    const med = median(slopes);
    // Plancher : 0,15 point par tranche de 1 % — évite de voir du bruit sur une courbe très lisse.
    const sigma = Math.max(robustSigma(slopes, med), 0.0015 / resolution);
    const dropThr = med - k * sigma;
    const spikeThr = Math.max(0, med + k * sigma);
    /** Variation entre a et b au-delà de l'érosion typique (pente médiane). */
    const excess = (a: number, b: number) => (ys[b] - ys[a] - med * (at(b) - at(a))) * 100;

    const spikes: (RetentionEvent & { a: number; p: number })[] = [];
    for (const r of runs(d.map(v => v > spikeThr), body, half)) {
      const a = Math.max(0, r.a - half);
      const lim = Math.min(n - 1, r.b + 2 * half);
      let p = r.a;
      for (let i = r.a; i <= lim; i++) if (ys[i] > ys[p]) p = i;
      let s = r.a;
      for (let i = r.a; i <= r.b; i++) if (d[i] > d[s]) s = i;
      const ex = excess(a, p);
      if (ex < minSpike) continue;
      spikes.push({ id: `spike-${Math.round(at(p))}`, kind: 'spike', start: at(a), end: at(p), at: at(p), value: y[p], deltaPts: (ys[p] - ys[a]) * 100, excessPts: ex, zScore: (d[s] - med) / sigma, a, p });
    }
    const drops: RetentionEvent[] = [];
    for (const r of runs(d.map(v => v < dropThr), body, half)) {
      // Contiguë à l'intro ou à l'écran de fin : déjà couverte par ces annotations.
      if (r.a <= first + half || r.b >= last - half) continue;
      // Descente qui suit un pic de revisionnage : on mesure la perte nette depuis avant le pic.
      const sp = spikes.find(z => r.a >= z.a && r.a <= z.p + 2 * half);
      const a = sp ? sp.a : Math.max(0, r.a - half);
      const b = Math.min(n - 1, r.b + half);
      let s = r.a;
      for (let i = r.a; i <= r.b; i++) if (d[i] < d[s]) s = i;
      const ex = excess(a, b);
      if (-ex < minDrop) continue;
      drops.push({ id: `drop-${Math.round(at(s))}`, kind: 'drop', start: at(a), end: at(b), at: at(s), value: y[s], deltaPts: (ys[b] - ys[a]) * 100, excessPts: ex, zScore: (med - d[s]) / sigma });
    }
    drops.sort((a, b) => a.excessPts - b.excessPts);
    spikes.sort((a, b) => b.excessPts - a.excessPts);
    events.push(...drops.slice(0, opts.maxDrops ?? 5), ...spikes.slice(0, opts.maxSpikes ?? 3).map(({ a: _a, p: _p, ...e }) => e));
  }

  // Fin : décrochage de l'écran de fin.
  const iOut = iOf(outroStart);
  const outDelta = (y[n - 1] - y[iOut]) * 100;
  if (iOut < n - 1 && -outDelta >= minDrop) {
    events.push({ id: 'outro', kind: 'outro', start: at(iOut), end: at(n - 1), at: at(iOut), value: y[iOut], deltaPts: outDelta, excessPts: outDelta, zScore: 0 });
  }
  return events.sort((a, b) => a.at - b.at);
}

/** Libellé français d'un événement. */
export const EVENT_LABELS: Record<EventKind, string> = {
  intro: 'Décrochage de l’intro',
  drop: 'Chute',
  spike: 'Pic (revisionnage)',
  outro: 'Fin / écran de fin',
};
