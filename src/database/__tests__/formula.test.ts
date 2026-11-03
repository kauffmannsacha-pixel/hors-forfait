import { describe, expect, it } from 'vitest';
import { formulaValue } from '../engine';
import { FormulaError, renamePropInFormula, referencedProps, runFormula, toDateFnsFormat, type FValue } from '../formula';
import { ctxOf, row, schema } from './helpers';

const env = (props: Record<string, FValue> = {}) => ({
  prop: (name: string) => { if (!(name in props)) throw new FormulaError(`Propriété introuvable : « ${name} »`); return props[name]; },
  now: () => new Date(2026, 10, 4, 10, 30),
});
const run = (src: string, props?: Record<string, FValue>) => {
  const r = runFormula(src, env(props));
  if (r.error !== undefined) throw new Error(r.error);
  return r.value;
};
const err = (src: string, props?: Record<string, FValue>) => runFormula(src, env(props)).error;

describe('formules : arithmétique et logique', () => {
  it('respecte les priorités', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('-2 ^ 2')).toBe(-4);
    expect(run('2 ^ 3 ^ 2')).toBe(512);
    expect(run('10 % 4')).toBe(2);
    expect(run('7 / 2')).toBe(3.5);
  });
  it('compare et combine', () => {
    expect(run('3 > 2 and 1 == 1')).toBe(true);
    expect(run('3 > 2 && 1 != 1')).toBe(false);
    expect(run('not true or false')).toBe(false);
    expect(run('!false')).toBe(true);
    expect(run('"b" > "a"')).toBe(true);
    expect(run('2 >= 2 ? "oui" : "non"')).toBe('oui');
  });
  it('concatène les textes avec +', () => {
    expect(run('"Vidéo " + 3')).toBe('Vidéo 3');
    expect(run('concat("a", "b", 1)')).toBe('ab1');
  });
});

describe('formules : fonctions', () => {
  it('if / empty / length / contains', () => {
    expect(run('if(prop("Vues") > 1000, "Top", "Bof")', { Vues: 1500 })).toBe('Top');
    expect(run('empty(prop("Note"))', { Note: '' })).toBe(true);
    expect(run('empty(prop("Tags"))', { Tags: [] })).toBe(true);
    expect(run('length("Prisme")')).toBe(6);
    expect(run('length(prop("Tags"))', { Tags: ['a', 'b'] })).toBe(2);
    expect(run('contains("Bonjour", "jour")')).toBe(true);
    expect(run('contains(prop("Tags"), "Short")', { Tags: ['Vidéo', 'Short'] })).toBe(true);
  });
  it('texte', () => {
    expect(run('replace("a-b-c", "-", "+")')).toBe('a+b-c');
    expect(run('replaceAll("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(run('lower("ÉTÉ")')).toBe('été');
    expect(run('upper("abc")')).toBe('ABC');
    expect(run('format(12)')).toBe('12');
    expect(run('prop("Nom").length()', { Nom: 'abc' })).toBe(3);
  });
  it('nombres', () => {
    expect(run('round(3.14159, 2)')).toBe(3.14);
    expect(run('round(2.5)')).toBe(3);
    expect(run('floor(2.7) + ceil(2.1)')).toBe(5);
    expect(run('abs(-4)')).toBe(4);
    expect(run('min(4, 2, 8)')).toBe(2);
    expect(run('max(4, 2, 8)')).toBe(8);
    expect(run('toNumber("1 234,5")')).toBe(1234.5);
    expect(run('toNumber(true)')).toBe(1);
    expect(run('prop("Prix") * prop("Qté")', { Prix: 2.5, 'Qté': null })).toBe(0);
  });
  it('dates', () => {
    const d = new Date(2026, 0, 31);
    expect((run('dateAdd(prop("D"), 1, "months")', { D: d }) as Date).getMonth()).toBe(1);
    expect((run('dateSubtract(prop("D"), 2, "jours")', { D: d }) as Date).getDate()).toBe(29);
    expect(run('dateBetween(prop("A"), prop("B"), "days")', { A: new Date(2026, 0, 10), B: new Date(2026, 0, 3) })).toBe(7);
    expect(run('formatDate(prop("D"), "DD/MM/YYYY")', { D: d })).toBe('31/01/2026');
    expect(run('formatDate(prop("D"), "d MMMM yyyy")', { D: d })).toBe('31 janvier 2026');
    expect((run('now()') as Date).getFullYear()).toBe(2026);
    expect(run('year(now())')).toBe(2026);
    expect(run('month(prop("D"))', { D: d })).toBe(1);
    expect(run('day(prop("D"))', { D: d })).toBe(6); // samedi
  });
});

describe('formules : erreurs lisibles', () => {
  it('signale les erreurs de syntaxe en français', () => {
    expect(err('1 +')).toMatch(/Fin de formule inattendue/);
    expect(err('(1 + 2')).toMatch(/« \) » attendu/);
    expect(err('"abc')).toMatch(/Texte non fermé/);
    expect(err('1 # 2')).toMatch(/Caractère inattendu « # »/);
    expect(err('')).toMatch(/vide/);
  });
  it('signale les erreurs sémantiques', () => {
    expect(err('foo(1)')).toBe('Fonction inconnue : « foo() »');
    expect(err('Prix * 2')).toMatch(/prop\("Prix"\)/);
    expect(err('if(true, 1)')).toBe('if() attend 3 arguments (reçu 2)');
    expect(err('prop("Inconnue")')).toBe('Propriété introuvable : « Inconnue »');
    expect(err('1 / 0')).toBe('Division par zéro');
    expect(err('round("abc")')).toMatch(/round\(\) attend un nombre/);
    expect(err('dateAdd(now(), 1, "lustres")')).toMatch(/unité inconnue/);
  });
});

describe('formules : intégration avec les propriétés', () => {
  const s = schema('db', [
    { id: 'p', name: 'Prix', type: 'number' },
    { id: 'q', name: 'Quantité', type: 'number' },
    { id: 's', name: 'Statut', type: 'status', options: [{ id: 'o1', name: 'Publié', color: 'green' }] },
    { id: 't', name: 'Total', type: 'formula', formula: 'prop("Prix") * prop("Quantité")' },
    { id: 'tt', name: 'TTC', type: 'formula', formula: 'round(prop("Total") * 1.2, 2)' },
    { id: 'ok', name: 'Publié ?', type: 'formula', formula: 'prop("Statut") == "Publié"' },
    { id: 'c1', name: 'A', type: 'formula', formula: 'prop("B") + 1' },
    { id: 'c2', name: 'B', type: 'formula', formula: 'prop("A") + 1' },
  ]);
  const r = row('db', 'Micro', { p: 49.9, q: 2, s: 'Publié' });
  const ctx = ctxOf(s, [r]);
  const prop = (id: string) => s.properties.find(p => p.id === id)!;
  it('évalue des formules imbriquées', () => {
    expect(formulaValue(r, prop('t'), ctx)).toBeCloseTo(99.8);
    expect(formulaValue(r, prop('tt'), ctx)).toBe(119.76);
    expect(formulaValue(r, prop('ok'), ctx)).toBe(true);
  });
  it('détecte les références circulaires', () => {
    expect(() => formulaValue(r, prop('c1'), ctx)).toThrow(/Référence circulaire/);
  });
  it('liste et renomme les références', () => {
    expect(referencedProps('prop("Prix") * prop(\'Quantité\')')).toEqual(['Prix', 'Quantité']);
    expect(renamePropInFormula('prop("Prix") * 2 + prop( "Prix" )', 'Prix', 'Tarif')).toBe('prop("Tarif") * 2 + prop("Tarif")');
  });
  it('convertit les formats façon Notion', () => {
    expect(toDateFnsFormat('DD/MM/YYYY')).toBe('dd/MM/yyyy');
    expect(toDateFnsFormat('dddd D MMMM [à] HH:mm')).toBe("EEEE d MMMM 'à' HH:mm");
  });
});
