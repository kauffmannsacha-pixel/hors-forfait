import { describe, expect, it } from 'vitest';
import { bootstrapProbGreater, detrendLogViews, evaluateAb, fillPeriods, fullDaysInPeriod, nextRotationTime, twoProportionZ } from '../abtest';
import { normalCdf } from '../stats';
import { addDays, ptMidnight } from '../tz';
import type { AbDaily, AbVariant } from '../types';

const H = 3_600_000;

describe('test z de deux proportions', () => {
  it('loi normale', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('5 % vs 3 % sur 1 000 impressions chacune', () => {
    const t = twoProportionZ(50, 1000, 30, 1000);
    expect(t.p1).toBeCloseTo(0.05);
    expect(t.p2).toBeCloseTo(0.03);
    expect(t.z).toBeCloseTo(2.282, 2);
    expect(t.pValueTwoSided).toBeCloseTo(0.0225, 3);
    expect(t.confidence).toBeCloseTo(0.9888, 3);
  });
  it('symétrique et neutre à égalité', () => {
    expect(twoProportionZ(30, 1000, 50, 1000).z).toBeCloseTo(-2.282, 2);
    expect(twoProportionZ(40, 1000, 40, 1000).confidence).toBeCloseTo(0.5, 6);
    expect(twoProportionZ(0, 0, 0, 0).z).toBe(0);
  });
});

describe('bootstrap et tendance', () => {
  it('reproductible et net quand les groupes sont séparés', () => {
    const p = bootstrapProbGreater([10, 11, 12, 13], [1, 2, 3], 2000, 3);
    expect(p).toBe(1);
    expect(bootstrapProbGreater([10, 11, 12, 13], [1, 2, 3], 2000, 3)).toBe(p);
    const q = bootstrapProbGreater([1, 2, 3], [10, 11, 12], 2000, 3);
    expect(q).toBe(0);
  });
  it('retire la décroissance des vues avec l’âge', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: i, views: Math.round(1000 * Math.exp(-0.2 * i)) }));
    const r = detrendLogViews(pts);
    r.forEach(x => expect(Math.abs(x)).toBeLessThan(0.01));
  });
});

describe('périodes et jours complets (heure du Pacifique)', () => {
  it('exclut les jours partiels', () => {
    const start = ptMidnight('2026-03-02') + 10 * H;
    const end = ptMidnight('2026-03-05');
    expect(fullDaysInPeriod({ start, end }, end + 1)).toEqual(['2026-03-03', '2026-03-04']);
  });
  it('gère le passage à l’heure d’été (journée de 23 h)', () => {
    expect(ptMidnight('2026-03-09') - ptMidnight('2026-03-08')).toBe(23 * H);
    expect(fullDaysInPeriod({ start: ptMidnight('2026-03-08') }, ptMidnight('2026-03-09') + 1)).toEqual(['2026-03-08']);
  });
  it('rotation alignée sur minuit PT avec des jours complets', () => {
    const d = '2026-03-02';
    expect(nextRotationTime(ptMidnight(d) + 5 * 60_000, 24)).toBe(ptMidnight('2026-03-03'));
    expect(nextRotationTime(ptMidnight(d) + 10 * H, 24)).toBe(ptMidnight('2026-03-04'));
    expect(nextRotationTime(ptMidnight(d) + 2 * 60_000, 72)).toBe(ptMidnight('2026-03-05'));
    expect(nextRotationTime(ptMidnight(d), 6)).toBe(ptMidnight('2026-03-03')); // minimum 24 h
  });
});

function alternating(days: number, first: string, metric: (variant: number, i: number) => Omit<AbDaily, 'date'>) {
  const variants: AbVariant[] = [
    { id: 'a', label: 'A', title: 'Titre A', periods: [] },
    { id: 'b', label: 'B', title: 'Titre B', periods: [] },
  ];
  const daily: AbDaily[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i); const v = i % 2;
    variants[v].periods.push({ start: ptMidnight(date), end: ptMidnight(addDays(date, 1)) });
    daily.push({ date, ...metric(v, i) });
  }
  return { variants, daily, now: ptMidnight(addDays(first, days)) + H };
}

describe('évaluation d’un test A/B', () => {
  it('CTR : désigne le gagnant avec un indice de confiance', () => {
    const { variants, daily, now } = alternating(8, '2026-04-01', v => ({ views: 900, impressions: 5000, ctr: v === 0 ? 0.06 : 0.045, avgViewDuration: 300 }));
    const ev = evaluateAb(variants, daily, { now, threshold: 0.95, minImpressions: 1000, minDays: 3 });
    expect(ev.metric).toBe('ctr');
    expect(ev.winnerIndex).toBe(0);
    expect(ev.confidence).toBeGreaterThan(0.99);
    expect(ev.lift).toBeCloseTo(0.06 / 0.045 - 1, 3);
    expect(ev.ready).toBe(true);
    expect(ev.stats[0].impressions).toBe(20000);
    expect(ev.stats[1].nDays).toBe(4);
  });
  it('pas encore prêt : impressions insuffisantes', () => {
    const { variants, daily, now } = alternating(4, '2026-04-01', v => ({ views: 50, impressions: 200, ctr: v === 0 ? 0.06 : 0.05 }));
    const ev = evaluateAb(variants, daily, { now, threshold: 0.95, minImpressions: 1000, minDays: 2 });
    expect(ev.ready).toBe(false);
    expect(ev.reasons.some(r => r.includes('impressions'))).toBe(true);
  });
  it('repli sur les vues/jour (bootstrap, tendance retirée) sans CTR', () => {
    const { variants, daily, now } = alternating(12, '2026-04-01', (v, i) => ({ views: Math.round(5000 * Math.exp(-0.08 * i) * (v === 1 ? 1.5 : 1)) }));
    const ev = evaluateAb(variants, daily, { now, threshold: 0.9, minImpressions: 1000, minDays: 3 });
    expect(ev.metric).toBe('views');
    expect(ev.winnerIndex).toBe(1);
    expect(ev.confidence).toBeGreaterThan(0.95);
    expect(ev.lift).toBeGreaterThan(0.3);
    expect(ev.ready).toBe(true);
  });
  it('remplit les périodes au format kv « abtests »', () => {
    const { variants, daily, now } = alternating(4, '2026-04-01', v => ({ views: 100 + v, impressions: 1000, ctr: 0.05, avgViewDuration: 200 }));
    const filled = fillPeriods(variants, daily, now);
    expect(filled[0].periods[0]).toMatchObject({ impressions: 1000, ctr: 0.05, views: 100, avgViewDuration: 200, days: 1 });
    expect(filled[1].periods[1]).toMatchObject({ views: 101 });
  });
});
