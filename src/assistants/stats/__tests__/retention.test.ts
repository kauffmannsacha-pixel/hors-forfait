import { describe, expect, it } from 'vitest';
import {
  defaultStep, interpolateRetention, linearInterpolator, monotoneInterpolator, nearestIndex,
  parseRetentionRows, sampleAt, summarizeRetention, type RetentionPoint,
} from '../lib/retention';

/** 100 points façon API : ratio 0,01 → 1, valeur f(ratio). */
const apiPoints = (f: (r: number) => number, rel?: (r: number) => number): RetentionPoint[] =>
  Array.from({ length: 100 }, (_, i) => { const r = (i + 1) / 100; return { ratio: r, watch: f(r), relative: rel ? rel(r) : null }; });

describe('parseRetentionRows', () => {
  it('lit les colonnes par nom, trie et ignore les lignes invalides', () => {
    const cols = ['elapsedVideoTimeRatio', 'audienceWatchRatio', 'relativeRetentionPerformance'];
    const rows = [[0.02, 0.8, 0.6], [0.01, 0.9, 0.55], ['x', 1, 1], [0.03, 0.7, null], [0.02, 0.81, 0.6]];
    const pts = parseRetentionRows(cols, rows);
    expect(pts.map(p => p.ratio)).toEqual([0.01, 0.02, 0.03]);
    expect(pts[0]).toEqual({ ratio: 0.01, watch: 0.9, relative: 0.55 });
    expect(pts[2].relative).toBeNull();
  });
  it('accepte une réponse sans relativeRetentionPerformance et signale une réponse invalide', () => {
    expect(parseRetentionRows(['elapsedVideoTimeRatio', 'audienceWatchRatio'], [[0.5, 0.4]])[0].relative).toBeNull();
    expect(() => parseRetentionRows(['views'], [[1]])).toThrow(/rétention/);
  });
});

describe('interpolateRetention (à la seconde)', () => {
  const D = 600;
  const pts = apiPoints(r => 1 - 0.5 * r, r => 0.4 + 0.2 * r);
  const series = interpolateRetention(pts, D);

  it('produit un échantillon par seconde de 0 à la durée', () => {
    expect(series.length).toBe(D + 1);
    expect(series[0].t).toBe(0);
    expect(series[series.length - 1].t).toBe(D);
    expect(series[10].t - series[9].t).toBe(1);
  });
  it('passe exactement par les points mesurés (t = ratio × durée)', () => {
    for (const p of [pts[0], pts[41], pts[99]]) {
      const s = series[Math.round(p.ratio * D)];
      expect(s.watch).toBeCloseTo(p.watch, 10);
      expect(s.measured).toBe(true);
    }
  });
  it('interpole linéairement entre deux mesures et marque les secondes estimées', () => {
    // points à 6 s et 12 s → la seconde 9 est la moyenne
    const mid = series[9];
    expect(mid.watch).toBeCloseTo((pts[0].watch + pts[1].watch) / 2, 10);
    expect(mid.measured).toBe(false);
    expect(mid.relative).toBeCloseTo((pts[0].relative! + pts[1].relative!) / 2, 10);
  });
  it('maintient la première valeur avant le premier point (0 → 1 % de la durée)', () => {
    expect(series[0].watch).toBeCloseTo(pts[0].watch, 10);
    expect(series[3].watch).toBeCloseTo(pts[0].watch, 10);
  });
  it('gère une durée non entière et un pas fin pour les Shorts', () => {
    expect(defaultStep(45)).toBe(0.5);
    expect(defaultStep(20)).toBe(0.25);
    const short = interpolateRetention(apiPoints(r => 1.2 - r), 20.3);
    expect(short[short.length - 1].t).toBeCloseTo(20.3, 6);
    expect(short[1].t).toBe(0.25);
    expect(short[short.length - 1].watch).toBeCloseTo(0.2, 6);
  });
  it('renvoie une série vide sans données ou sans durée', () => {
    expect(interpolateRetention([], 100)).toEqual([]);
    expect(interpolateRetention(pts, 0)).toEqual([]);
  });
  it('option monotone : passe par les points et ne dépasse pas entre deux points monotones', () => {
    const wavy = apiPoints(r => 1 - 0.6 * r - 0.05 * Math.sin(r * 20) ** 2);
    const mono = interpolateRetention(wavy, D, { method: 'monotone' });
    for (const p of wavy) expect(mono[Math.round(p.ratio * D)].watch).toBeCloseTo(p.watch, 9);
    for (let i = 0; i < wavy.length - 1; i++) {
      const a = wavy[i], b = wavy[i + 1];
      const lo = Math.min(a.watch, b.watch) - 1e-12, hi = Math.max(a.watch, b.watch) + 1e-12;
      for (let t = Math.round(a.ratio * D); t <= Math.round(b.ratio * D); t++) {
        expect(mono[t].watch).toBeGreaterThanOrEqual(lo);
        expect(mono[t].watch).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe('interpolateurs et lecture', () => {
  it('linéaire et monotone coïncident sur une droite', () => {
    const xs = [0, 1, 2, 3, 4], ys = [1, 0.8, 0.6, 0.4, 0.2];
    const l = linearInterpolator(xs, ys), m = monotoneInterpolator(xs, ys);
    for (const x of [0.5, 1.25, 3.9]) expect(m(x)).toBeCloseTo(l(x), 10);
    expect(l(-5)).toBe(1);
    expect(l(99)).toBe(0.2);
  });
  it('sampleAt lit la série entre deux échantillons ; nearestIndex trouve le plus proche', () => {
    const s = [{ t: 0, watch: 1 }, { t: 1, watch: 0.5 }, { t: 2, watch: 0.25 }];
    expect(sampleAt(s, 0.5)).toBeCloseTo(0.75);
    expect(sampleAt(s, 1.5)).toBeCloseTo(0.375);
    expect(sampleAt(s, 5)).toBe(0.25);
    expect(nearestIndex(s, 1.4)).toBe(1);
    expect(nearestIndex(s, 1.6)).toBe(2);
  });
  it('summarizeRetention calcule moyenne (≈ % moyen regardé) et repères', () => {
    const series = interpolateRetention(apiPoints(r => 1 - 0.5 * r), 600);
    const sum = summarizeRetention(series, 600)!;
    expect(sum.meanWatch).toBeGreaterThan(0.74);
    expect(sum.meanWatch).toBeLessThan(0.76);
    expect(sum.middle).toBeCloseTo(0.75, 2);
    expect(sum.end).toBeCloseTo(0.5, 6);
    expect(sum.early.t).toBe(30);
  });
});
