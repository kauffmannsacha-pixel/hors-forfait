import { describe, expect, it } from 'vitest';
import { centeredSlope, detectEvents, introOutro, median, movingAverage, robustSigma, SENSITIVITY } from '../lib/events';
import { interpolateRetention, type RetentionPoint } from '../lib/retention';

const D = 600;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** Courbe réaliste : décrochage d'intro, érosion lente, chute nette à 200 s, pic de revisionnage à 400 s, écran de fin. */
const curve = (t: number) =>
  1 - 0.3 * (1 - Math.exp(-t / 8)) - 0.0004 * t
  - 0.08 * sigmoid((t - 200) / 2)
  + 0.05 * Math.exp(-((t - 400) ** 2) / (2 * 4 ** 2))
  - 0.06 * sigmoid((t - 590) / 1.5);
/** Bruit pseudo-aléatoire déterministe (±amp). */
const noise = (i: number, amp: number) => amp * Math.sin(i * 12.9898 + 78.233) * Math.cos(i * 4.1414);
const toPoints = (f: (t: number) => number, amp = 0): RetentionPoint[] =>
  Array.from({ length: 100 }, (_, i) => { const r = (i + 1) / 100; return { ratio: r, watch: f(r * D) + noise(i, amp), relative: null }; });

describe('outils de lissage', () => {
  it('moyenne mobile centrée et pente', () => {
    expect(movingAverage([0, 3, 6, 9], 1)).toEqual([1.5, 3, 6, 7.5]);
    expect(centeredSlope([0, 2, 4, 6], 1, 1)).toEqual([2, 2, 2, 2]);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(robustSigma([1, 1, 1, 1])).toBe(0);
  });
  it('zones intro / fin bornées', () => {
    expect(introOutro(600)).toEqual({ introEnd: 30, outroStart: 580 });
    const s = introOutro(40);
    expect(s.introEnd).toBeCloseTo(4);
    expect(s.outroStart).toBeCloseTo(37); // zone de fin : 3 s minimum
  });
});

describe('detectEvents — pics et chutes annotés', () => {
  const series = interpolateRetention(toPoints(curve), D);
  const events = detectEvents(series, D);

  it('annote toujours le décrochage de l’intro', () => {
    const intro = events.find(e => e.kind === 'intro')!;
    expect(intro).toBeDefined();
    expect(intro.end).toBe(30);
    // l'API ne mesure pas t = 0 : la référence est le premier point (1 % de la durée = 6 s)
    expect(intro.deltaPts).toBeCloseTo((curve(30) - curve(6)) * 100, 0);
    expect(intro.deltaPts).toBeLessThan(-10);
  });
  it('trouve la chute nette autour de 200 s avec sa magnitude', () => {
    const drops = events.filter(e => e.kind === 'drop');
    expect(drops.length).toBe(1);
    expect(Math.abs(drops[0].at - 200)).toBeLessThanOrEqual(8);
    expect(drops[0].deltaPts).toBeLessThan(-6);
    expect(drops[0].deltaPts).toBeGreaterThan(-12);
    // au-delà de l'érosion normale : ≈ la marche de 8 points de la courbe
    expect(drops[0].excessPts).toBeLessThan(-6.5);
    expect(drops[0].excessPts).toBeGreaterThan(-9.5);
    expect(drops[0].start).toBeLessThan(drops[0].at);
    expect(drops[0].end).toBeGreaterThan(drops[0].at);
  });
  it('trouve le pic de revisionnage autour de 400 s', () => {
    const spikes = events.filter(e => e.kind === 'spike');
    expect(spikes.length).toBe(1);
    expect(Math.abs(spikes[0].at - 400)).toBeLessThanOrEqual(8);
    expect(spikes[0].deltaPts).toBeGreaterThan(1.5);
  });
  it('annote l’écran de fin et trie par temps', () => {
    expect(events[events.length - 1].kind).toBe('outro');
    const times = events.map(e => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
  it('reste robuste au bruit de mesure (±0,3 pt) : mêmes événements, pas de faux positifs', () => {
    const noisy = detectEvents(interpolateRetention(toPoints(curve, 0.003), D), D);
    const drops = noisy.filter(e => e.kind === 'drop');
    const spikes = noisy.filter(e => e.kind === 'spike');
    expect(drops.length).toBe(1);
    expect(Math.abs(drops[0].at - 200)).toBeLessThanOrEqual(10);
    expect(spikes.length).toBe(1);
  });
  it('aucune chute ni pic sur une érosion régulière', () => {
    const flat = detectEvents(interpolateRetention(toPoints(t => 0.9 - 0.0005 * t), D), D);
    expect(flat.filter(e => e.kind === 'drop' || e.kind === 'spike')).toEqual([]);
  });
  it('la sensibilité haute détecte une chute plus douce que la sensibilité basse', () => {
    const soft = (t: number) => 0.9 - 0.0004 * t - 0.025 * sigmoid((t - 300) / 5);
    const s = interpolateRetention(toPoints(soft), D);
    const high = detectEvents(s, D, { sensitivity: SENSITIVITY.haute }).filter(e => e.kind === 'drop');
    const low = detectEvents(s, D, { sensitivity: SENSITIVITY.basse, minDropPts: 3 }).filter(e => e.kind === 'drop');
    expect(high.length).toBe(1);
    expect(Math.abs(high[0].at - 300)).toBeLessThanOrEqual(12);
    expect(low.length).toBe(0);
  });
  it('ignore une série trop courte', () => {
    expect(detectEvents([{ t: 0, watch: 1 }, { t: 1, watch: 0.9 }], 1)).toEqual([]);
  });
});
