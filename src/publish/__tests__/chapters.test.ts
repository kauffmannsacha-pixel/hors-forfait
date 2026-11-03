import { describe, expect, it } from 'vitest';
import {
  chapterTitle, chaptersToText, docToSections, extractHeadingTime, formatTimestamp, generateChapters, normalizeChapters,
  parseTimestamp, scriptSections, sectionsFromMeta, validateChapters,
} from '../chapters';

const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const words = (n: number) => Array.from({ length: n }, (_, i) => 'mot' + i).join(' ');

describe('minutages', () => {
  it('parseTimestamp', () => {
    expect(parseTimestamp('1:30')).toBe(90);
    expect(parseTimestamp('01:02:03')).toBe(3723);
    expect(parseTimestamp('45 s')).toBe(45);
    expect(parseTimestamp('2 min 10')).toBe(130);
    expect(parseTimestamp('90')).toBe(90);
    expect(parseTimestamp('bientôt')).toBeNull();
  });
  it('formatTimestamp', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(75)).toBe('01:15');
    expect(formatTimestamp(3725)).toBe('1:02:05');
    expect(formatTimestamp(75, true)).toBe('0:01:15');
  });
  it('minutage écrit dans les intertitres', () => {
    expect(extractHeadingTime('[1:30] Le plan')).toEqual({ title: 'Le plan', start: 90 });
    expect(extractHeadingTime('Hook (0-30 s)')).toEqual({ title: 'Hook', start: 0 });
    expect(extractHeadingTime('Payoff — 8:10')).toEqual({ title: 'Payoff', start: 490 });
    expect(extractHeadingTime('Sans minutage')).toEqual({ title: 'Sans minutage' });
  });
});

describe('page Script → chapitres', () => {
  const doc = {
    type: 'doc', content: [
      h(1, 'Mon script'),
      h(2, 'Hook (0-30 s)'), p("J'ai piraté le Wi-Fi de mon voisin. Et il ne s'en doute pas."), p(words(60)),
      h(2, 'Promesse'), p(words(150)),
      h(2, 'Corps : la construction du piège'), p(words(450)), h(3, 'Détail'), p(words(30)),
      h(2, 'Payoff'), p(words(300)),
      h(2, 'CTA'), p('[SFX] Abonne-toi, la vidéo est finie.'),
    ],
  };
  it('docToSections découpe par intertitre (H3 fusionnés dans le H2)', () => {
    const s = docToSections(doc);
    expect(s.map(x => x.title)).toEqual(['Mon script', 'Hook', 'Promesse', 'Corps : la construction du piège', 'Payoff', 'CTA']);
    expect(s[1].start).toBe(0);
    expect(s[3].words).toBe(480);
    expect(s[5].words).toBe(5); // [SFX] ignoré, « Abonne-toi » = 1 mot
  });
  it('titres lisibles pour le spectateur', () => {
    expect(chapterTitle({ title: 'Corps : la construction du piège', text: '' })).toBe('La construction du piège');
    expect(chapterTitle({ title: 'Hook', text: "J'ai piraté le Wi-Fi de mon voisin. Et il ne s'en doute pas." })).toBe("J'ai piraté le Wi-Fi de mon voisin");
    expect(chapterTitle({ title: 'Payoff', text: '' })).toBe('Le résultat');
    expect(chapterTitle({ title: 'Le test sur Lucas', text: 'blabla' })).toBe('Le test sur Lucas');
  });
  it('generateChapters : minutages estimés au débit de parole, premier à 00:00', () => {
    const g = generateChapters(docToSections(doc), { wpm: 150 });
    expect(g.estimated).toBe(true);
    expect(g.chapters[0]).toEqual({ start: 0, title: "J'ai piraté le Wi-Fi de mon voisin" });
    expect(g.chapters.map(c => c.start)).toEqual([0, 29, 89, 281]); // 73 mots → 29 s, +150 → 89 s, +480 → 281 s ; le CTA (2 s) est retiré
    expect(g.warnings.some(w => w.includes('estimés'))).toBe(true);
  });
  it('generateChapters : recalage sur la durée réelle de la vidéo', () => {
    const g = generateChapters(docToSections(doc), { wpm: 150, durationSec: 800 });
    const last = g.chapters[g.chapters.length - 1];
    expect(last.start).toBeLessThan(800);
    expect(g.chapters[2].start).toBe(Math.round((223 / 1008) * 800));
  });
  it('minutages explicites prioritaires', () => {
    const d2 = { type: 'doc', content: [h(2, '[0:00] Intro'), p(words(20)), h(2, '[1:30] Le plan'), p(words(200)), h(2, '[5:00] Le test'), p(words(200))] };
    const g = generateChapters(docToSections(d2));
    expect(g.chapters).toEqual([{ start: 0, title: 'Intro' }, { start: 90, title: 'Le plan' }, { start: 300, title: 'Le test' }]);
    expect(g.estimated).toBe(false);
    expect(chaptersToText(g.chapters)).toBe('00:00 Intro\n01:30 Le plan\n05:00 Le test');
  });
  it('sections déclarées dans page.meta', () => {
    const meta = { sections: [{ title: 'Hook', start: '0-30 s', text: 'Je vais tout casser.' }, { title: 'Le plan', start: '1:00' }, { title: 'Le résultat', start: 420 }] };
    const s = sectionsFromMeta(meta)!;
    expect(s.map(x => x.start)).toEqual([0, 60, 420]);
    expect(scriptSections({ meta, content: { type: 'doc', content: [] } })).toHaveLength(3);
    expect(sectionsFromMeta({ other: 1 })).toBeNull();
  });
});

describe('règles YouTube des chapitres', () => {
  it('normalise : 1er à 0, fusion < 10 s, pas au-delà de la fin', () => {
    const n = normalizeChapters([{ start: 3, title: 'A' }, { start: 8, title: 'B' }, { start: 60, title: 'C' }, { start: 595, title: 'D' }], 600);
    expect(n).toEqual([{ start: 0, title: 'A' }, { start: 60, title: 'C' }]);
  });
  it('valide', () => {
    expect(validateChapters([{ start: 0, title: 'A' }, { start: 30, title: 'B' }, { start: 90, title: 'C' }], 300)).toEqual([]);
    const bad = validateChapters([{ start: 5, title: 'A' }, { start: 10, title: 'B' }], 300);
    expect(bad).toContain('Il faut au moins 3 chapitres pour que YouTube les affiche.');
    expect(bad).toContain('Le premier chapitre doit commencer à 00:00.');
    expect(bad.some(m => m.includes('moins de 10 secondes'))).toBe(true);
  });
  it('format heures pour les vidéos longues', () => {
    expect(chaptersToText([{ start: 0, title: 'A' }, { start: 3700, title: 'B' }])).toBe('0:00:00 A\n1:01:40 B');
  });
});
