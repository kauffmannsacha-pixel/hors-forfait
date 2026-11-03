import { describe, expect, it } from 'vitest';
import { decodeEntities, detectTechniquesLocal, parseJsonLines, segmentTranscript, techniqueCounts, timelineSegments, toAnnotation } from '../analysis';

const seg = (start: number, text: string, dur = 3) => ({ start, dur, text });

describe('découpage de transcription en blocs horodatés', () => {
  it('fait des blocs fins sur le hook puis ~20 s', () => {
    const segs = Array.from({ length: 40 }, (_, i) => seg(i * 3, `phrase numéro ${i}.`));
    const blocks = segmentTranscript(segs);
    expect(blocks[0].start).toBe(0);
    expect(blocks[0].end - blocks[0].start).toBeLessThanOrEqual(12);
    const later = blocks.filter(b => b.start >= 30);
    for (const b of later.slice(0, -1)) {
      expect(b.end - b.start).toBeGreaterThanOrEqual(20);
      expect(b.end - b.start).toBeLessThanOrEqual(40);
    }
    expect(blocks.map(b => b.i)).toEqual(blocks.map((_, i) => i));
    // aucune perte de texte
    expect(blocks.map(b => b.text).join(' ')).toBe(segs.map(s => s.text).join(' '));
  });
  it('nettoie entités HTML et [Musique]', () => {
    expect(decodeEntities('l&#39;idée &amp; co')).toBe("l'idée & co");
    const blocks = segmentTranscript([seg(0, '[Musique]'), seg(1, 'c&#39;est parti !')]);
    expect(blocks[0].text).toBe("c'est parti !");
  });
});

describe('annotation locale des techniques', () => {
  it('repère hook, boucle ouverte, obstacle, escalade et payoff', () => {
    const blocks = [
      { i: 0, start: 0, end: 8, text: 'I bought every car in the world.' },
      { i: 1, start: 8, end: 30, text: "But before that, I need to find a garage. Later in this video I'll give one away." },
      { i: 2, start: 30, end: 60, text: "The problem is it didn't work at all." },
      { i: 3, start: 60, end: 90, text: 'This time we go even bigger with 100 cars.' },
      { i: 4, start: 90, end: 120, text: 'Finally, we did it!' },
    ];
    const ann = detectTechniquesLocal(blocks);
    const kinds = (i: number) => ann.filter(a => a.i === i).map(a => a.kind);
    expect(kinds(0)).toContain('hook');
    expect(kinds(1)).toContain('boucle');
    expect(kinds(2)).toContain('obstacle');
    expect(kinds(3)).toContain('escalade');
    expect(kinds(4)).toContain('payoff');
    expect(techniqueCounts(ann).find(t => t.kind === 'hook')?.count).toBe(1);
  });
  it('frise : positions en % et couleur de la technique prioritaire', () => {
    const blocks = [{ i: 0, start: 0, end: 10, text: 'a' }, { i: 1, start: 10, end: 40, text: 'b' }];
    const segs = timelineSegments(blocks, [{ i: 1, kind: 'boucle', why: '', source: 'local' }, { i: 1, kind: 'payoff', why: '', source: 'local' }]);
    expect(segs[0].left).toBe(0);
    expect(segs[0].width).toBe(25);
    expect(segs[0].primary).toBeNull();
    expect(segs[1].left).toBe(25);
    expect(segs[1].primary).toBe('payoff');
    expect(segs[1].kinds).toEqual(['payoff', 'boucle']);
  });
});

describe('flux JSON Lines de Claude', () => {
  it('ne renvoie que les lignes complètes', () => {
    const { items, rest } = parseJsonLines<{ i: number }>('{"i":0}\n{"i":1}\n{"i":');
    expect(items).toEqual([{ i: 0 }, { i: 1 }]);
    expect(rest).toBe('{"i":');
  });
  it('valide les annotations (types inconnus et index hors limites ignorés)', () => {
    expect(toAnnotation({ i: 2, techniques: [{ type: 'boucle', explication: 'x', citation: 'y' }, { type: 'inconnu' }] }, 5))
      .toEqual([{ i: 2, kind: 'boucle', why: 'x', quote: 'y', source: 'claude' }]);
    expect(toAnnotation({ i: 9, techniques: [{ type: 'hook' }] }, 5)).toEqual([]);
  });
});
