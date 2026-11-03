// Heure de publication optimale — calculée UNIQUEMENT à partir de MES données (pure, testée).
// L'API YouTube ne fournit pas le graphique « Quand vos spectateurs sont sur YouTube » (réservé à YouTube Studio) :
// on mesure donc, pour chaque vidéo passée, les vues des 48 premières heures et on cherche quels jours/heures
// de publication font mieux que la médiane de la chaîne.
import { clamp, median, normalCdf, std } from './stats';
import { addDays, DAY_NAMES, localTimeZone, ptDate, ptDayFraction, zonedParts, zonedTimeToUtc } from './tz';

export interface DayViews { date: string /* AAAA-MM-JJ (PT) */; views: number }
export interface EarlySample { videoId: string; title?: string; publishedAt: number; early: number; source: 'analytics' | 'snapshots' }

/**
 * Vues des `hours` premières heures à partir des vues journalières YouTube Analytics (jours PT).
 * Fenêtre 48 h = reste du jour J (toutes ses vues, la vidéo n'existait pas avant) + J+1 + fraction f de J+2,
 * f étant la part du jour J déjà écoulée au moment de la publication.
 */
export function earlyViewsFromDaily(daily: DayViews[], publishedAt: number, hours: 24 | 48 = 48, assumeMissingZero = false): number | null {
  const d0 = ptDate(publishedAt);
  const map = new Map(daily.map(d => [d.date, d.views]));
  const get = (d: string) => map.get(d) ?? (assumeMissingZero ? 0 : undefined);
  const full = hours / 24;
  let total = get(d0);
  if (total == null) return null;
  for (let i = 1; i < full; i++) { const v = get(addDays(d0, i)); if (v == null) return null; total += v; }
  const f = ptDayFraction(publishedAt);
  if (f > 0.01) { const v = get(addDays(d0, full)); if (v == null) return null; total += f * v; }
  return total;
}

/** Vues à publication + `hours` par interpolation linéaire entre deux instantanés (écart ≤ 12 h). */
export function earlyViewsFromSnapshots(points: { t: number; views: number }[], publishedAt: number, hours = 48): number | null {
  const target = publishedAt + hours * 3_600_000;
  const pts = points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.views) && p.t >= publishedAt - 3_600_000).sort((a, b) => a.t - b.t);
  const after = pts.find(p => p.t >= target);
  if (!after) return null;
  const befores = pts.filter(p => p.t <= target);
  const before = befores.length ? befores[befores.length - 1] : { t: publishedAt, views: 0 };
  if (after.t === before.t) return after.views;
  if (after.t - before.t > 12 * 3_600_000) return null;
  return before.views + ((after.views - before.views) * (target - before.t)) / (after.t - before.t);
}

export interface SlotSuggestion { day: number /* 0 = lundi */; hour: number; mult: number; dayN: number; hourWeight: number }
export interface OptimalResult {
  n: number; timeZone: string; medianEarly: number;
  grid: number[][];                                    // [7][24] multiplicateur prédit vs médiane
  dayEffects: { day: number; mult: number; n: number }[];
  hourEffects: { hour: number; mult: number; weight: number }[];
  best: SlotSuggestion[];
  confidence: 'insuffisante' | 'faible' | 'moyenne' | 'bonne';
  confidenceScore: number;                             // 0..1 (≈ P(le meilleur créneau bat la médiane))
  z: number;
  explanation: string[];
}

const circDist = (a: number, b: number) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };

export function computeOptimal(samplesIn: EarlySample[], opts: { timeZone?: string; prior?: number; bandwidth?: number } = {}): OptimalResult {
  const tz = opts.timeZone ?? localTimeZone();
  const prior = opts.prior ?? 2;          // rétrécissement vers 0 (≈ 2 vidéos « moyennes » fictives par groupe)
  const sigma = opts.bandwidth ?? 1.5;    // lissage des heures (± 1,5 h)
  const samples = samplesIn.filter(s => Number.isFinite(s.early) && s.early >= 0 && Number.isFinite(s.publishedAt));
  const n = samples.length;
  const med = median(samples.map(s => s.early));
  const empty: OptimalResult = {
    n, timeZone: tz, medianEarly: med, grid: Array.from({ length: 7 }, () => Array(24).fill(1)),
    dayEffects: Array.from({ length: 7 }, (_, day) => ({ day, mult: 1, n: 0 })), hourEffects: Array.from({ length: 24 }, (_, hour) => ({ hour, mult: 1, weight: 0 })),
    best: [], confidence: 'insuffisante', confidenceScore: 0, z: 0, explanation: [],
  };
  if (n === 0) return { ...empty, explanation: ['Aucune vidéo exploitable : publie quelques vidéos (ou connecte YouTube Analytics) pour obtenir une suggestion.'] };

  const pts = samples.map(s => {
    const z = zonedParts(s.publishedAt, tz);
    return { day: z.weekday, h: z.hour + z.minute / 60, y: clamp(Math.log((s.early + 1) / (med + 1)), -2.5, 2.5) };
  });
  const w = (h: number, hi: number) => Math.exp(-(circDist(h, hi) ** 2) / (2 * sigma * sigma));
  let dayEff = Array(7).fill(0) as number[];
  const hourEffAt = (h: number, de: number[]) => {
    let num = 0, den = 0;
    for (const p of pts) { const k = w(h, p.h); num += k * (p.y - de[p.day]); den += k; }
    return { eff: num / (den + prior), weight: den };
  };
  let hourAtSample = pts.map(() => 0);
  for (let it = 0; it < 3; it++) {           // rétro-ajustement : jour, puis heure, puis jour…
    const de = Array(7).fill(0) as number[]; const dn = Array(7).fill(0) as number[];
    pts.forEach((p, i) => { de[p.day] += p.y - hourAtSample[i]; dn[p.day]++; });
    dayEff = de.map((s, d) => s / (dn[d] + prior));
    hourAtSample = pts.map(p => hourEffAt(p.h, dayEff).eff);
  }
  const dayN = Array(7).fill(0) as number[]; pts.forEach(p => dayN[p.day]++);
  const hours = Array.from({ length: 24 }, (_, h) => hourEffAt(h, dayEff));
  const grid = dayEff.map(d => hours.map(h => Math.exp(d + h.eff)));
  const resid = pts.map((p, i) => p.y - dayEff[p.day] - hourAtSample[i]);
  const sd = Math.max(0.3, std(resid) || std(pts.map(p => p.y)) || 0.5);

  const cells: SlotSuggestion[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push({ day: d, hour: h, mult: grid[d][h], dayN: dayN[d], hourWeight: hours[h].weight });
  const supported = (minW: number) => cells.filter(c => c.dayN >= 1 && c.hourWeight >= minW);
  const pool = (supported(0.6).length ? supported(0.6) : supported(0.25).length ? supported(0.25) : cells).sort((a, b) => b.mult - a.mult);
  const best: SlotSuggestion[] = [];
  for (const c of pool) {
    if (best.some(b => b.day === c.day && circDist(b.hour, c.hour) <= 1)) continue;
    best.push(c); if (best.length === 3) break;
  }
  const top = best[0];
  const eff = top ? Math.log(top.mult) : 0;
  const se = sd * Math.sqrt(1 / ((top?.dayN ?? 0) + prior) + 1 / ((top?.hourWeight ?? 0) + prior));
  const z = se > 0 ? eff / se : 0;
  const score = normalCdf(z);
  const confidence: OptimalResult['confidence'] = n < 6 ? 'insuffisante' : z >= 2 && n >= 15 ? 'bonne' : z >= 1 ? 'moyenne' : 'faible';
  const fmtN = (x: number) => Math.round(x).toLocaleString('fr-FR');
  const explanation = [
    `Méthode : pour tes ${n} dernières vidéos, Prisme estime les vues des 48 premières heures (instantanés horaires quand ils existent, sinon vues journalières YouTube Analytics — jours en heure du Pacifique — au prorata de l'heure de publication), les compare à ta médiane (${fmtN(med)} vues en 48 h), puis isole l'effet du jour de la semaine et de l'heure de publication (lissage ± ${sigma} h, résultats ramenés vers la moyenne quand un créneau a peu de vidéos).`,
    "L'API YouTube ne fournit pas « quand tes spectateurs sont en ligne » (graphique réservé à YouTube Studio) : la suggestion repose uniquement sur les performances passées de ta chaîne.",
    `Confiance ${confidence} : ${n} vidéo(s) ; le meilleur créneau fait ×${(top?.mult ?? 1).toFixed(2).replace('.', ',')} la médiane, soit ${z.toFixed(1).replace('.', ',')} écart-type (${Math.round(score * 100)} % de chances d'être réellement au-dessus de la médiane).`,
    'Corrélation, pas causalité : le sujet, le titre et la miniature pèsent bien plus que l’heure. Utilise ce créneau pour départager, pas pour décider.',
  ];
  if (n < 6) explanation.push('Moins de 6 vidéos : suggestion très fragile, à reconsidérer après quelques publications.');
  return {
    n, timeZone: tz, medianEarly: med, grid,
    dayEffects: dayEff.map((e, day) => ({ day, mult: Math.exp(e), n: dayN[day] })),
    hourEffects: hours.map((h, hour) => ({ hour, mult: Math.exp(h.eff), weight: h.weight })),
    best, confidence, confidenceScore: score, z, explanation,
  };
}

/** Prochaine occurrence (dans le fuseau) d'un créneau jour/heure, au moins `minLeadMs` après maintenant. */
export function nextSlotOccurrence(day: number, hour: number, now: number, tz = localTimeZone(), minLeadMs = 60 * 60_000): number {
  const z = zonedParts(now, tz);
  for (let i = 0; i < 15; i++) {
    const cal = new Date(Date.UTC(z.year, z.month - 1, z.day + i));
    const wd = (cal.getUTCDay() + 6) % 7; // 0 = lundi
    if (wd !== day) continue;
    const ts = zonedTimeToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), hour, 0, tz);
    if (ts >= now + minLeadMs) return ts;
  }
  return now + 7 * 86_400_000;
}

export const slotLabel = (s: { day: number; hour: number }) => `${DAY_NAMES[s.day]} ${String(s.hour).padStart(2, '0')} h`;
