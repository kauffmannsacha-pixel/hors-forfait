import { describe, expect, it } from 'vitest';
import { blocksFromJSON, hasWrittenText, inlineMarkdown, markdownToDoc, scriptToPrompt, stripFences, templateDoc } from '../doc';
import { analyzeScript } from '../heuristics';
import { SECTION_DEFS } from '../method';

describe('markdownToDoc (sortie de Claude → TipTap)', () => {
  it('convertit titres, lignes labellisées, listes et règles', () => {
    const doc = markdownToDoc([
      '## Hook',
      '### [0:00] Cold open',
      '**Voix :** « T\'habites à Narbonne ! »',
      '**Visuel :** gros plan',
      '',
      '- boucle 1',
      '- boucle 2',
      '1. premier',
      '2. second',
      '---',
      '> citation',
    ].join('\n'));
    const types = doc.content!.map(n => n.type);
    expect(types).toEqual(['heading', 'heading', 'paragraph', 'paragraph', 'bulletList', 'orderedList', 'horizontalRule', 'blockquote']);
    expect(doc.content![0].attrs).toEqual({ level: 2 });
    const voix = doc.content![2].content!;
    expect(voix[0]).toEqual({ type: 'text', text: 'Voix :', marks: [{ type: 'bold' }] });
    expect(voix[1].text).toBe(' « T\'habites à Narbonne ! »');
    expect(doc.content![4].content).toHaveLength(2);
  });
  it('gère l\'inline imbriqué et les liens', () => {
    expect(inlineMarkdown('a **gras *et italique* fin** b')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'gras ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'et italique', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { type: 'text', text: ' fin', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' b' },
    ]);
    expect(inlineMarkdown('[source](https://youtu.be/x)')[0].marks).toEqual([{ type: 'link', attrs: { href: 'https://youtu.be/x' } }]);
    expect(inlineMarkdown('snake_case_word')).toEqual([{ type: 'text', text: 'snake_case_word' }]);
  });
  it('transforme un tableau en paragraphes « — »', () => {
    const doc = markdownToDoc('| Temps | Voix |\n|---|---|\n| 0:00 | Hook |');
    expect(doc.content!.map(n => n.content?.[0]?.text)).toEqual(['Temps — Voix', '0:00 — Hook']);
  });
  it('retire les balises ```markdown', () => {
    expect(stripFences('```markdown\n## Hook\n```')).toBe('## Hook');
  });
});

describe('blocs d\'analyse depuis le JSON TipTap', () => {
  it('aplatit les blocs imbriqués et garde l\'index de premier niveau', () => {
    const blocks = blocksFromJSON({
      type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hook' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Ligne ' }, { type: 'hardBreak' }, { type: 'text', text: 'deux' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
        { type: 'callout', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dans un callout' }, { type: 'filePin', attrs: { hash: 'x' } }] }] },
      ],
    });
    expect(blocks).toEqual([
      { text: 'Hook', heading: 2, code: undefined, top: 0 },
      { text: 'Ligne \ndeux', heading: undefined, code: undefined, top: 1 },
      { text: 'item', heading: undefined, code: undefined, top: 2 },
      { text: 'dans un callout ', heading: undefined, code: undefined, top: 3 },
    ]);
  });
  it('le gabarit guidé contient les 7 sections reconnues', () => {
    const blocks = blocksFromJSON(templateDoc());
    const a = analyzeScript(blocks, { targetSec: 600 });
    expect(a.sections.map(s => s.kind)).toEqual(SECTION_DEFS.map(d => d.kind));
    expect(hasWrittenText(blocks)).toBe(false);
  });
  it('prépare un script horodaté pour Claude', () => {
    const blocks = blocksFromJSON(markdownToDoc('## Hook\nPremière phrase du hook.\nVisuel : plan large'));
    const a = analyzeScript(blocks, {});
    expect(scriptToPrompt(blocks, a.blockTimes)).toBe('## Hook\n[0:00] Première phrase du hook.\nVisuel : plan large');
  });
});
