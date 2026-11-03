// Tests A/B titres + miniatures : statistiques et calendrier de rotation (pure, testée).
// YouTube Analytics (et le rapport « Portée » de la Reporting API) ne donnent que des chiffres PAR JOUR,
// découpés en heure du Pacifique : une variante doit donc rester en ligne au moins 24 h, alignée sur minuit PT,
// sinon une même journée mélangerait deux variantes et serait inexploitable.
import { clamp, linearFit, mean, mulberry32, normalCdf } from './stats';
import { addDays, ptDate, ptMidnight } from './tz';
import type { AbDaily, AbPeriod, AbVariant } from './types';

export const MIN_INTERVAL_HOURS = 24;
export const INTERVAL_CHOICES = [24, 48, 72, 96, 168];

// ── Tests statistiques ───────────────────────────────────────
export interface ZTest { z: number; p1: number; p2: number; pValueTwoSided: number; /** P(variante 1 meilleure) ≈ Φ(z) */ confidence: number }
/** Test z de deux proportions (CTR = clics / impressions), variance groupée. */
export function twoProportionZ(c1: number, n1: number, c2: number, n2: number): ZTest {
  const p1 = n1 > 0 ? c1 / n1 : 0, p2 = n2 > 0 ? c2 / n2 : 0;
  const p = n1 + n2 > 0 ? (c1 + c2) / (n1 + n2) : 0;
  const se = Math.sqrt(p * (1 - p) * ((n1 > 0 ? 1 / n1 : 0) + (n2 > 0 ? 1 / n2 : 0)));
  const z = se > 0 ? (p1 - p2) / se : 0;
  return { z, p1, p2, pValueTwoSided: 2 * (1 - normalCdf(Math.abs(z))), confidence: normalCdf(z) };
}

/** Probabilité (bootstrap reproductible) que la moyenne de `a` dépasse celle de `b`. */
export function bootstrapProbGreater(a: number[], b: number[], iterations = 4000, seed = 7): number {
  if (!a.length || !b.length) return 0.5;
  const rnd = mulberry32(seed);
  const resampleMean = (x: number[]) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[Math.floor(rnd() * x.length)]; return s / x.length; };
  let wins = 0;
  for (let i = 0; i < iterations; i++) {
    const d = resampleMean(a) - resampleMean(b);
    wins += d > 0 ? 1 : d === 0 ? 0.5 : 0;
  }
  return wins / iterations;
}

/** Résidus de log(vues + 1) après une tendance linéaire dans le temps (les vues d'une vidéo décroissent avec l'âge). */
export function detrendLogViews(points: { t: number; views: number }[]): number[] {
  const ys = points.map(p => Math.log(Math.max(0, p.views) + 1));
  if (points.length < 3) return ys.map(y => y - mean(ys));
  const { a, b } = linearFit(points.map(p => p.t), ys);
  return points.map((p, i) => ys[i] - (a + b * p.t));
}

// ── Périodes ↔ jours PT ─────────────────────────────────────
/** Jours PT entièrement couverts par une période [start, end) — les jours partiels sont exclus. */
export function fullDaysInPeriod(p: Pick<AbPeriod, 'start' | 'end'>, now: number): string[] {
  const end = Math.min(p.end ?? now, now);
  let d = ptDate(p.start);
  if (ptMidnight(d) < p.start) d = addDays(d, 1);
  const out: string[] = [];
  while (ptMidnight(addDays(d, 1)) <= end && out.length < 1000) { out.push(d); d = addDays(d, 1); }
  return out;
}

export interface PeriodAggregate { impressions?: number; clicks?: number; ctr?: number; views: number; avgViewDuration?: number; days: number }
export function aggregateDays(days: AbDaily[]): PeriodAggregate {
  const views = days.reduce((s, d) => s + (d.views || 0), 0);
  const withImp = days.filter(d => d.impressions != null && d.ctr != null);
  const impressions = withImp.reduce((s, d) => s + (d.impressions ?? 0), 0);
  const clicks = withImp.reduce((s, d) => s + (d.impressions ?? 0) * (d.ctr ?? 0), 0);
  const withDur = days.filter(d => d.avgViewDuration != null && d.views > 0);
  const durViews = withDur.reduce((s, d) => s + d.views, 0);
  const avgViewDuration = durViews > 0 ? withDur.reduce((s, d) => s + (d.avgViewDuration ?? 0) * d.views, 0) / durViews : undefined;
  return {
    views, days: days.length,
    ...(withImp.length ? { impressions, clicks, ctr: impressions > 0 ? clicks / impressions : 0 } : {}),
    ...(avgViewDuration != null ? { avgViewDuration } : {}),
  };
}

/** Renseigne impressions/CTR/vues/durée moyenne de chaque période à partir des données journalières. */
export function fillPeriods(variants: AbVariant[], daily: AbDaily[], now: number): AbVariant[] {
  const byDate = new Map(daily.map(d => [d.date, d]));
  return variants.map(v => ({
    ...v,
    periods: v.periods.map(p => {
      const days = fullDaysInPeriod(p, now).map(d => byDate.get(d)).filter((x): x is AbDaily => !!x);
      const a = aggregateDays(days);
      return { start: p.start, ...(p.end != null ? { end: p.end } : {}), days: a.days, views: a.views, ...(a.impressions != null ? { impressions: a.impressions, ctr: a.ctr } : {}), ...(a.avgViewDuration != null ? { avgViewDuration: a.avgViewDuration } : {}) };
    }),
  }));
}

// ── Évaluation ───────────────────────────────────────────────
export interface VariantStats { id: string; label: string; days: AbDaily[]; nDays: number; impressions: number; clicks: number; ctr: number | null; views: number; viewsPerDay: number; avgViewDuration: number | null }
export interface AbEvaluation { metric: 'ctr' | 'views'; stats: VariantStats[]; winnerIndex: number | null; confidence: number; lift: number; ready: boolean; reasons: string[] }
export interface AbOptions { now: number; threshold: number; minImpressions: number; minDays: number }

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function variantStats(variants: AbVariant[], daily: AbDaily[], now: number): VariantStats[] {
  const byDate = new Map(daily.map(d => [d.date, d]));
  return variants.map(v => {
    const dates = [...new Set(v.periods.flatMap(p => fullDaysInPeriod(p, now)))].sort();
    const days = dates.map(d => byDate.get(d)).filter((x): x is AbDaily => !!x);
    const a = aggregateDays(days);
    return {
      id: v.id, label: v.label, days, nDays: days.length,
      impressions: a.impressions ?? 0, clicks: a.clicks ?? 0, ctr: a.ctr ?? null,
      views: a.views, viewsPerDay: days.length ? a.views / days.length : 0, avgViewDuration: a.avgViewDuration ?? null,
    };
  });
}

export function evaluateAb(variants: AbVariant[], daily: AbDaily[], o: AbOptions): AbEvaluation {
  const stats = variantStats(variants, daily, o.now);
  const reasons: string[] = [];
  if (stats.length < 2) return { metric: 'views', stats, winnerIndex: null, confidence: 0, lift: 0, ready: false, reasons: ['Il faut au moins 2 variantes.'] };
  const ctrOk = stats.every(s => s.impressions > 0 && s.ctr != null);
  for (const s of stats) if (s.nDays < o.minDays) reasons.push(`Variante ${s.label} : ${s.nDays}/${o.minDays} jour(s) complet(s) mesuré(s).`);

  if (ctrOk) {
    const order = stats.map((s, i) => i).sort((a, b) => (stats[b].ctr ?? 0) - (stats[a].ctr ?? 0));
    const w = order[0], second = order[1];
    let conf = 1;
    for (const j of order.slice(1)) conf = Math.min(conf, twoProportionZ(stats[w].clicks, stats[w].impressions, stats[j].clicks, stats[j].impressions).confidence);
    for (const s of stats) if (s.impressions < o.minImpressions) reasons.push(`Variante ${s.label} : ${Math.round(s.impressions)}/${o.minImpressions} impressions.`);
    if (conf < o.threshold) reasons.push(`Confiance ${pct(conf)} < ${pct(o.threshold)} requis.`);
    const lift = (stats[second].ctr ?? 0) > 0 ? (stats[w].ctr ?? 0) / (stats[second].ctr ?? 1) - 1 : 0;
    return { metric: 'ctr', stats, winnerIndex: w, confidence: conf, lift, ready: !reasons.length, reasons };
  }

  // Repli : vues/jour, tendance d'âge retirée, bootstrap sur les jours.
  reasons.unshift('CTR des impressions indisponible (rapport « Portée » pas encore généré) : comparaison sur les vues/jour.');
  const all = stats.flatMap((s, vi) => s.days.map(d => ({ vi, t: ptMidnight(d.date) / 86_400_000, views: d.views })));
  const res = detrendLogViews(all);
  const groups = stats.map((_, vi) => res.filter((_r, k) => all[k].vi === vi));
  const means = groups.map(g => (g.length ? mean(g) : -Infinity));
  const order = means.map((_, i) => i).sort((a, b) => means[b] - means[a]);
  const w = order[0], second = order[1];
  let conf = 1;
  for (const j of order.slice(1)) conf = Math.min(conf, groups[w].length >= 2 && groups[j].length >= 2 ? bootstrapProbGreater(groups[w], groups[j], 4000, 11 + j) : 0.5);
  if (conf < o.threshold) reasons.push(`Confiance ${pct(conf)} < ${pct(o.threshold)} requis.`);
  const lift = Number.isFinite(means[w]) && Number.isFinite(means[second]) ? Math.exp(clamp(means[w] - means[second], -5, 5)) - 1 : 0;
  const blocking = reasons.slice(1);
  return { metric: 'views', stats, winnerIndex: Number.isFinite(means[w]) ? w : null, confidence: conf, lift, ready: !blocking.length && Number.isFinite(means[w]), reasons };
}

// ── Calendrier de rotation ───────────────────────────────────
/**
 * Prochaine rotation : aligne sur minuit PT et garantit `intervalHours/24` jours COMPLETS à la variante.
 * Une rotation faite dans l'heure qui suit minuit PT compte comme alignée (le planificateur tourne toutes les 5 min).
 */
export function nextRotationTime(rotationAt: number, intervalHours: number): number {
  const days = Math.max(1, Math.round(Math.max(MIN_INTERVAL_HOURS, intervalHours) / 24));
  const d = ptDate(rotationAt);
  const aligned = rotationAt - ptMidnight(d) <= 60 * 60_000;
  return ptMidnight(addDays(d, days + (aligned ? 0 : 1)));
}
/** Variante suivante (rotation circulaire). */
export const nextVariantIndex = (current: number, count: number) => (count > 0 ? (current + 1) % count : 0);
