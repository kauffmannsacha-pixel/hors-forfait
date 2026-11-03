import { describe, expect, it } from 'vitest';
import { addDays, dailySeries, dateInTz, daysBetween, envelope, hourlySeries, medianOf, quantileSorted, viewsPerDay } from '../lib/series';
import { keywordsFromTitle, transcriptStructure } from '../lib/structure';
import { fmtClock, fmtPct, fmtPts } from '../lib/format';

const H = 3_600_000;

describe('statistiques d’ensemble', () => {
  it('quantiles et médiane', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(medianOf([9, 1, 5])).toBe(5);
  });
  it('enveloppe point par point (ignore les valeurs absentes, n minimum)', () => {
    const env = envelope([[1, 10, null], [3, 20, 5], [2, 30, null]], 3);
    expect(env[0]).toEqual({ n: 3, min: 1, p25: 1.5, median: 2, p75: 2.5, max: 3 });
    expect(env[1]?.median).toBe(20);
    expect(env[2]).toBeNull();
  });
});

describe('dates en heure du Pacifique', () => {
  it('convertit un instant UTC en date PT', () => {
    expect(dateInTz(Date.UTC(2026, 10, 3, 5, 0))).toBe('2026-11-02'); // 21 h PT la veille
    expect(dateInTz(Date.UTC(2026, 10, 3, 9, 0))).toBe('2026-11-03');
  });
  it('arithmétique sur AAAA-MM-JJ', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(daysBetween('2026-10-30', '2026-11-03')).toBe(4);
  });
});

describe('vues par heure (instantanés Prisme)', () => {
  const pub = Date.UTC(2026, 10, 1, 16, 0);
  it('interpole entre instantanés proches et part de 0 vue à la publication', () => {
    const snaps = [{ t: pub + 0.5 * H, views: 500 }, { t: pub + 1.5 * H, views: 1500 }, { t: pub + 2.5 * H, views: 2000 }];
    const s = hourlySeries(snaps, pub, 4, { now: pub + 2.6 * H });
    expect(s.map(p => p.cum)).toEqual([0, 1000, 1750, null, null]);
    expect(s[1].delta).toBe(1000);
    expect(s[2].delta).toBe(750);
    expect(s[1].measured).toBe(false);
  });
  it('n’invente pas de valeur quand Prisme était fermé (trou > 2 h)', () => {
    const snaps = [{ t: pub + 1 * H, views: 800 }, { t: pub + 9 * H, views: 5000 }];
    const s = hourlySeries(snaps, pub, 10, { now: pub + 10 * H });
    expect(s[1]).toEqual({ h: 1, cum: 800, delta: 800, measured: true });
    expect(s[5].cum).toBeNull();
    expect(s[9].cum).toBe(5000);
    expect(s[9].delta).toBeNull();
  });
});

describe('vues par jour (Analytics)', () => {
  it('aligne sur J0, complète les jours sans ligne par 0 et s’arrête à la dernière date connue', () => {
    const rows = [{ date: '2026-10-01', views: 100 }, { date: '2026-10-03', views: 40 }];
    const s = dailySeries(rows, '2026-10-01', 4);
    expect(s.map(p => p.views)).toEqual([100, 0, 40, null, null]);
    expect(s.map(p => p.cum)).toEqual([100, 100, 140, null, null]);
    expect(s[2].date).toBe('2026-10-03');
  });
  it('vues par jour depuis la publication', () => {
    const now = Date.UTC(2026, 10, 3);
    expect(viewsPerDay(1000, new Date(now - 4 * 24 * H).toISOString(), now)).toBe(250);
  });
});

describe('structure de transcription (comparaison)', () => {
  const sentences = [
    { index: 0, start: 0, end: 5, text: 'J’ai piraté 10 000 comptes Netflix ?' },
    { index: 1, start: 5, end: 30, text: 'Mais vous verrez plus tard pourquoi c’est une mauvaise idée.' },
    { index: 2, start: 30, end: 60, text: 'On commence par le plus simple.' },
  ];
  it('mesure débit, questions, boucles ouvertes et accroche', () => {
    const st = transcriptStructure(sentences, 60, 30);
    expect(st.words).toBe(23);
    expect(st.wpm).toBe(23);
    expect(st.questions).toBe(1);
    expect(st.loopMarkers).toBe(3);
    expect(st.firstLoopAt).toBe(5);
    expect(st.hookNumbers).toBe(1);
    expect(st.hookText.startsWith('J’ai piraté')).toBe(true);
    expect(st.paceBuckets.length).toBe(20);
    const total = st.paceBuckets.reduce((a, b) => a + b, 0) * (60 / 20 / 60);
    expect(total).toBeCloseTo(23, 6);
  });
  it('mots-clés d’un titre pour trouver des références', () => {
    expect(keywordsFromTitle('J’ai piraté le Wi-Fi de mon VOISIN 😈 (il a pas aimé)')).toBe('piraté wi-fi voisin aimé');
    expect(keywordsFromTitle('Minecraft', ['speedrun', 'minecraft', 'fr'])).toBe('minecraft speedrun');
  });
});

describe('formatage', () => {
  it('horloge, pourcentages et points', () => {
    expect(fmtClock(65)).toBe('1:05');
    expect(fmtClock(3723)).toBe('1:02:03');
    expect(fmtPct(0.452)).toBe('45,2 %');
    expect(fmtPts(-4.24)).toBe('−4,2 pts');
    expect(fmtPts(1)).toBe('+1 pt');
  });
});
