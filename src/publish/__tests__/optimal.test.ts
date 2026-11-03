import { describe, expect, it } from 'vitest';
import { computeOptimal, earlyViewsFromDaily, earlyViewsFromSnapshots, nextSlotOccurrence, type EarlySample } from '../optimal';
import { mulberry32 } from '../stats';
import { ptMidnight, zonedTimeToUtc } from '../tz';

const H = 3_600_000;

describe('vues des premières heures', () => {
  const pub = ptMidnight('2026-01-05') + 18 * H; // 18 h PT → 75 % du jour écoulé
  const daily = [{ date: '2026-01-05', views: 1000 }, { date: '2026-01-06', views: 2000 }, { date: '2026-01-07', views: 800 }];
  it('48 h = J + J+1 + fraction de J+2', () => {
    expect(earlyViewsFromDaily(daily, pub, 48)).toBeCloseTo(1000 + 2000 + 0.75 * 800, 6);
  });
  it('24 h = J + fraction de J+1', () => {
    expect(earlyViewsFromDaily(daily, pub, 24)).toBeCloseTo(1000 + 0.75 * 2000, 6);
  });
  it('données manquantes', () => {
    expect(earlyViewsFromDaily(daily.slice(0, 2), pub, 48)).toBeNull();
    expect(earlyViewsFromDaily(daily.slice(0, 2), pub, 48, true)).toBeCloseTo(3000, 6);
  });
  it('instantanés : interpolation à +48 h', () => {
    const t0 = Date.UTC(2026, 0, 5, 12);
    const pts = [{ t: t0 + 47 * H, views: 4700 }, { t: t0 + 49 * H, views: 4900 }];
    expect(earlyViewsFromSnapshots(pts, t0, 48)).toBeCloseTo(4800, 6);
    expect(earlyViewsFromSnapshots([{ t: t0 + 30 * H, views: 10 }], t0, 48)).toBeNull();
  });
});

describe('heure de publication optimale', () => {
  const tz = 'Europe/Paris';
  // 36 vidéos : celles du jeudi 17 h font ~2× la médiane, les autres ~1× (bruit ±15 %).
  const rnd = mulberry32(42);
  const samples: EarlySample[] = [];
  const slots = [[0, 12], [1, 18], [2, 10], [3, 17], [4, 20], [5, 14], [6, 11]];
  for (let k = 0; k < 36; k++) {
    const [day, hour] = slots[k % slots.length];
    const date = new Date(Date.UTC(2026, 0, 5 + day + 7 * Math.floor(k / 7)));
    const ts = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, 0, tz);
    const base = day === 3 ? 20000 : 10000;
    samples.push({ videoId: 'v' + k, publishedAt: ts, early: base * (0.85 + 0.3 * rnd()), source: 'analytics' });
  }
  it('trouve le créneau gagnant (jeudi 17 h, heure locale)', () => {
    const r = computeOptimal(samples, { timeZone: tz });
    expect(r.n).toBe(36);
    expect(r.best[0].day).toBe(3);
    expect(Math.abs(r.best[0].hour - 17)).toBeLessThanOrEqual(1);
    expect(r.best[0].mult).toBeGreaterThan(1.3);
    expect(['moyenne', 'bonne']).toContain(r.confidence);
    expect(r.grid).toHaveLength(7);
    expect(r.grid[0]).toHaveLength(24);
    expect(r.explanation.join(' ')).toContain('48 premières heures');
  });
  it('données insuffisantes', () => {
    const r = computeOptimal(samples.slice(0, 3), { timeZone: tz });
    expect(r.confidence).toBe('insuffisante');
    expect(computeOptimal([], { timeZone: tz }).best).toEqual([]);
  });
  it('prochaine occurrence du créneau', () => {
    const now = zonedTimeToUtc(2026, 11, 2, 10, 0, tz); // lundi 2 novembre 2026, 10 h à Paris
    const next = nextSlotOccurrence(3, 17, now, tz);
    expect(new Date(next).toISOString()).toBe('2026-11-05T16:00:00.000Z');
    const sameDay = nextSlotOccurrence(0, 10, now, tz);
    expect(new Date(sameDay).toISOString()).toBe('2026-11-09T09:00:00.000Z'); // < 1 h d'avance → semaine suivante
  });
});
