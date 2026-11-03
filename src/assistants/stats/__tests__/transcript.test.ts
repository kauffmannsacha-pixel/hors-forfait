import { describe, expect, it } from 'vitest';
import {
  buildSentences, cleanCaptionText, isPunctuated, normalizeSegments, sentenceAt, sentenceStats,
  textBetween, tokenize, wordIndexAt, worstSentences,
} from '../lib/transcript';
import { interpolateRetention, sampleAt } from '../lib/retention';

describe('nettoyage des sous-titres', () => {
  it('décode les entités et retire balises et marqueurs de locuteur', () => {
    expect(cleanCaptionText('l&#39;IA &amp; moi &quot;ok&quot;')).toBe('l\'IA & moi "ok"');
    expect(cleanCaptionText('>> <c>Salut</c>   tout&nbsp;le monde')).toBe('Salut tout le monde');
    expect(cleanCaptionText('&#x1F600; &bogus;')).toBe('😀 &bogus;');
  });
  it('trie, fusionne les segments de même départ et supprime les chevauchements', () => {
    const segs = normalizeSegments([
      { start: 4, dur: 5, text: 'trois' },
      { start: 0, dur: 6, text: 'un' },
      { start: 0, dur: 2, text: 'deux' },
      { start: 9, dur: 0, text: '' },
    ]);
    expect(segs).toEqual([
      { start: 0, dur: 4, text: 'un deux' },
      { start: 4, dur: 5, text: 'trois' },
    ]);
  });
  it('borne le dernier segment à la durée de la vidéo', () => {
    expect(normalizeSegments([{ start: 58, dur: 10, text: 'fin' }], 60)[0].dur).toBe(2);
  });
  it('horodate chaque mot au prorata de sa longueur', () => {
    const toks = tokenize([{ start: 10, dur: 2, text: 'a bbb' }]);
    expect(toks.map(t => t.w)).toEqual(['a', 'bbb']);
    expect(toks[0].t0).toBe(10);
    // poids = longueur + 1 espace : « a » = 2/6 de la durée
    expect(toks[0].t1).toBeCloseTo(10 + 2 / 3);
    expect(toks[1].t1).toBeCloseTo(12);
  });
});

describe('phrases alignées sur l’axe du temps', () => {
  const punctuated = [
    { start: 0, dur: 2, text: 'Salut. Aujourd\'hui on' },
    { start: 2, dur: 2, text: 'teste un truc fou !' },
    { start: 4, dur: 3, text: 'Vous allez voir... ça marche.' },
    { start: 9, dur: 3, text: 'M. Dupont arrive. Et là ?' },
  ];
  it('détecte une transcription ponctuée', () => {
    expect(isPunctuated(normalizeSegments(punctuated))).toBe(true);
    expect(isPunctuated([{ start: 0, dur: 2, text: 'salut tout le monde on teste un truc' }])).toBe(false);
  });
  it('coupe aux fins de phrase, y compris au milieu d’un segment', () => {
    const s = buildSentences(punctuated);
    expect(s.map(x => x.text)).toEqual([
      'Salut.',
      'Aujourd\'hui on teste un truc fou !',
      'Vous allez voir... ça marche.',
      'M. Dupont arrive.',
      'Et là ?',
    ]);
    expect(s[0].start).toBe(0);
    // « Salut. » occupe 7/22 des caractères du premier segment de 2 s
    expect(s[1].start).toBeCloseTo((7 / 22) * 2, 6);
    expect(s[1].end).toBeCloseTo(4);
    expect(s[2].start).toBeCloseTo(4);
    expect(s[4].end).toBeCloseTo(12);
    expect(s.map(x => x.index)).toEqual([0, 1, 2, 3, 4]);
  });
  it('regroupe les sous-titres automatiques (sans ponctuation) par silences et blocs de ~3,5 s', () => {
    const auto = [
      { start: 0, dur: 1.5, text: 'salut tout le monde' },
      { start: 1.5, dur: 1.5, text: 'aujourd\'hui on va' },
      { start: 3, dur: 1.5, text: 'pirater le wifi' },
      { start: 6, dur: 2, text: 'du voisin' },
    ];
    const s = buildSentences(auto);
    expect(s.map(x => x.text)).toEqual(['salut tout le monde aujourd\'hui on va pirater le wifi', 'du voisin']);
    expect(s[1].start).toBe(6);
  });
  it('trouve la phrase exacte prononcée à un instant donné', () => {
    const s = buildSentences(punctuated);
    expect(sentenceAt(s, 0.2)?.text).toBe('Salut.');
    expect(sentenceAt(s, 3)?.text).toBe('Aujourd\'hui on teste un truc fou !');
    expect(sentenceAt(s, 5.5)?.text).toBe('Vous allez voir... ça marche.');
    // silence entre 7 s et 9 s : la phrase la plus proche dans la tolérance (1 s)
    expect(sentenceAt(s, 7.4)?.text).toBe('Vous allez voir... ça marche.');
    expect(sentenceAt(s, 8.6)?.text).toBe('M. Dupont arrive.');
    expect(sentenceAt(s, 8, 0.5)).toBeNull();
    expect(sentenceAt([], 3)).toBeNull();
  });
  it('estime le mot prononcé dans la phrase', () => {
    const sent = { index: 0, start: 10, end: 14, text: 'un deux trois quatre' };
    expect(wordIndexAt(sent, 10)).toBe(0);
    expect(wordIndexAt(sent, 12.2)).toBe(2);
    expect(wordIndexAt(sent, 14)).toBe(3);
  });
  it('mesure la perte d’audience pendant chaque phrase et classe les pires', () => {
    const pts = Array.from({ length: 100 }, (_, i) => { const r = (i + 1) / 100; const t = r * 100; return { ratio: r, watch: t < 40 ? 0.9 : t < 50 ? 0.9 - (t - 40) * 0.01 : 0.8, relative: null }; });
    const series = interpolateRetention(pts, 100);
    const sentences = [
      { index: 0, start: 10, end: 20, text: 'Phrase stable.' },
      { index: 1, start: 40, end: 50, text: 'La phrase qui fait fuir.' },
      { index: 2, start: 60, end: 70, text: 'Encore stable.' },
    ];
    const stats = sentenceStats(sentences, t => sampleAt(series, t));
    expect(stats[0].deltaPts).toBeCloseTo(0, 6);
    expect(stats[1].deltaPts).toBeCloseTo(-10, 6);
    expect(stats[1].ratePer10s).toBeCloseTo(-10, 6);
    expect(worstSentences(stats, 3).map(s => s.index)).toEqual([1]);
    expect(textBetween(sentences, 35, 61)).toBe('La phrase qui fait fuir. Encore stable.');
  });
});
