import { describe, expect, it } from 'vitest';
import { compareVariants, declaredWinner, parseAbTests, variantStats } from '../lib/abtest';
import { countWords, extractCitations, normalizeConcept, normalizeEmotion, normalizeVision } from '../lib/normalize';
import { nicheInsights } from '../lib/insights';
import type { Principle } from '../../../knowledge/api';
import type { ThumbRecord } from '../lib/types';

const P: Principle[] = [
  { id: '1', topic: 'thumbnail', title: '3 éléments max', text: '…', source: { creator: 'Paddy Galloway', timestamp: 222, kind: 'youtube' } },
  { id: '2', topic: 'thumbnail', title: 'Visage expressif', text: '…', source: { creator: 'MrBeast', kind: 'document' } },
];

describe('normalisation des réponses Vision', () => {
  it('émotions FR/EN ramenées au vocabulaire du filtre', () => {
    expect(normalizeEmotion('Shocked')).toBe('surprise');
    expect(normalizeEmotion('excitée')).toBe('joie');
    expect(normalizeEmotion('Méfiance')).toBe('curiosité');
    expect(normalizeEmotion('', false)).toBe('aucune');
    expect(normalizeEmotion('aucune', true)).toBe('neutre');
  });
  it('compte les mots, borne les valeurs et résout les citations [n]', () => {
    expect(countWords('JE SUIS RICHE ?!')).toBe(3);
    const v = normalizeVision({ face: 'oui', emotion: 'fear', emotionIntensity: 14, text: '100 000 $ GAGNÉS', focalPoint: { x: 1.4, y: -2 }, whyItWorks: ['Peu d’éléments [1]', 'Regard caméra [2, 1]'] }, P);
    expect(v.face).toBe(true); expect(v.emotion).toBe('peur'); expect(v.emotionIntensity).toBe(10);
    expect(v.wordCount).toBe(2); // « 100 000 $ » = un seul mot visuel
    expect(countWords('IL A 1 000 000 € ?')).toBe(3);
    expect(v.hasText).toBe(true);
    expect(v.focalPoint).toMatchObject({ x: 1, y: 0 });
    expect(v.whyItWorks).toEqual(['Peu d’éléments', 'Regard caméra']);
    expect(v.citations).toEqual(['Principe : 3 éléments max — source : Paddy Galloway, 03:42', 'Principe : Visage expressif — source : MrBeast']);
    expect(extractCitations('rien [9]', P).citations).toEqual([]);
  });
  it('concept : texte limité à 3 mots et croquis borné', () => {
    const c = normalizeConcept({ name: 'Choc', text: 'IL A TOUT PERDU CE SOIR', colors: ['#ff0000', 'rouge'], sketch: [{ kind: 'face', x: 2, y: 0.2, w: 0.4, h: 0.6, emotion: 'shock' }, { kind: 'arrow', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }, P);
    expect(c.text).toBe('IL A TOUT'); expect(c.textTooLong).toBe(true);
    expect(c.colors).toEqual(['#ff0000']);
    expect(c.sketch[0]).toMatchObject({ kind: 'visage', x: 1, emotion: 'surprise' });
    expect(c.sketch[1].kind).toBe('fleche');
  });
});

describe('tests A/B (kv « abtests »)', () => {
  const raw = [{ videoId: 'abcdefghijk', variants: [
    { thumbnailHash: 'h1', title: 'A', periods: [{ start: 1, end: 2, impressions: 10000, ctr: 4.0, views: 400, avgViewDuration: 300 }, { impressions: 10000, ctr: 4.4, views: 440, avgViewDuration: 320 }] },
    { thumbnailHash: 'h2', title: 'B', periods: [{ impressions: 20000, ctr: 6.0, views: 1200, avgViewDuration: 280 }] },
  ], winner: 'h2' }];
  it('agrège les périodes (CTR en % détecté) et calcule le meneur', () => {
    const [t] = parseAbTests(raw);
    const s = variantStats(t);
    expect(s[0].impressions).toBe(20000);
    expect(s[0].ctr).toBeCloseTo(0.042, 6);
    expect(s[0].avgViewDuration).toBeCloseTo((400 * 300 + 440 * 320) / 840, 6);
    const cmp = compareVariants(s)!;
    expect(cmp.leader).toBe(1); expect(cmp.significant).toBe(true); expect(cmp.lift).toBeCloseTo(6 / 4.2 - 1, 6);
    expect(declaredWinner(t)).toBe(1);
  });
  it('accepte un objet indexé et des formats de gagnant variés', () => {
    const tests = parseAbTests({ t1: { ...raw[0], winner: 0 }, t2: { videoId: 'x', variants: [], winner: 'B' } });
    expect(tests).toHaveLength(2);
    expect(declaredWinner(tests[0])).toBe(0);
    expect(declaredWinner(tests[1])).toBeNull();
    expect(compareVariants(variantStats(tests[1]))).toBeNull();
  });
});

describe('synthèse de niche', () => {
  const rec = (i: number, face: boolean, ratio: number): ThumbRecord => ({
    videoId: 'v' + i, title: 't', channelId: 'c', channelTitle: 'C', publishedAt: '', durationSec: 600, views: 1000 * i, ratio, niche: 'n', source: { kind: 'niche', query: 'n' }, imageUrl: '', analyzedAt: 0,
    vision: normalizeVision({ face, emotion: face ? 'surprise' : 'aucune', text: i % 2 ? 'OUI' : '', elementCount: 2 }),
  });
  it('parts et écart de performance avec/sans visage', () => {
    const recs = [rec(1, true, 3), rec(2, true, 4), rec(3, true, 5), rec(4, false, 1), rec(5, false, 1.5), rec(6, false, 2)];
    const ins = nicheInsights(recs);
    expect(ins.faceShare).toBeCloseTo(0.5, 6);
    expect(ins.emotions[0]).toMatchObject({ key: 'surprise', count: 3 });
    const face = ins.lifts.find(l => l.feature === 'Visage')!;
    expect(face.metric).toBe('ratio'); expect(face.withMedian).toBe(4); expect(face.withoutMedian).toBe(1.5);
  });
});
