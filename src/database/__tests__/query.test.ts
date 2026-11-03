import { describe, expect, it } from 'vitest';
import { applyFilters, applySearch, applySorts, computeCalc, groupRows, prefillFromFilters, valueForGroup } from '../query';
import { ctxOf, row, schema } from './helpers';

const s = schema('db', [
  { id: 'st', name: 'Statut', type: 'status', options: [{ id: 'a', name: 'Idée', color: 'gray' }, { id: 'b', name: 'Script', color: 'blue' }, { id: 'c', name: 'Publié', color: 'green' }] },
  { id: 'v', name: 'Vues', type: 'number' },
  { id: 'tg', name: 'Tags', type: 'multi_select', options: [{ id: 't1', name: 'Short', color: 'red' }, { id: 't2', name: 'Tuto', color: 'blue' }] },
  { id: 'd', name: 'Date', type: 'date' },
  { id: 'ok', name: 'Sponsorisé', type: 'checkbox' },
  { id: 'who', name: 'Monteur', type: 'person' },
  { id: 'f', name: 'Score', type: 'formula', formula: 'prop("Vues") / 100' },
]);
const people = [{ id: 'p1', name: 'Léa', color: 'blue' }, { id: 'p2', name: 'Hugo', color: 'green' }];
const rows = [
  row('db', 'Écran géant', { st: 'Publié', v: 12000, tg: ['Short'], d: '2026-11-04', ok: true, who: ['p1'] }),
  row('db', 'arbre secret', { st: 'Idée', v: 300, tg: ['Tuto', 'Short'], d: '2026-11-20' }),
  row('db', 'Base Roblox 10', { st: 'Script', d: { start: '2026-10-30', end: '2026-11-02' }, who: ['p2'] }),
  row('db', 'Base Roblox 2', { st: 'b', v: 5000, d: '2026-11-03T18:00' }),
];
const ctx = ctxOf(s, rows, [], people); // maintenant = mercredi 4 nov. 2026
const titles = (r: typeof rows) => r.map(x => x.title);
const f = (filters: { propId: string; op: string; value?: unknown }[], mode: 'and' | 'or' = 'and') => titles(applyFilters(rows, { filters, filterMode: mode }, ctx));

describe('filtres', () => {
  it('texte (insensible aux accents et à la casse)', () => {
    expect(f([{ propId: 'title', op: 'contains', value: 'ecran' }])).toEqual(['Écran géant']);
    expect(f([{ propId: 'title', op: 'starts_with', value: 'base' }])).toEqual(['Base Roblox 10', 'Base Roblox 2']);
    expect(f([{ propId: 'title', op: 'is', value: 'ARBRE SECRET' }])).toEqual(['arbre secret']);
    expect(f([{ propId: 'title', op: 'not_contains', value: 'roblox' }])).toEqual(['Écran géant', 'arbre secret']);
  });
  it('nombre et vide', () => {
    expect(f([{ propId: 'v', op: 'gt', value: 1000 }])).toEqual(['Écran géant', 'Base Roblox 2']);
    expect(f([{ propId: 'v', op: 'lte', value: '300' }])).toEqual(['arbre secret']);
    expect(f([{ propId: 'v', op: 'empty' }])).toEqual(['Base Roblox 10']);
    expect(f([{ propId: 'v', op: 'not_empty' }]).length).toBe(3);
  });
  it('statut par nom ou par id d’option', () => {
    expect(f([{ propId: 'st', op: 'is', value: 'Script' }])).toEqual(['Base Roblox 10', 'Base Roblox 2']);
    expect(f([{ propId: 'st', op: 'is_not', value: 'c' }])).toEqual(['arbre secret', 'Base Roblox 10', 'Base Roblox 2']);
  });
  it('sélection multiple, case, personne', () => {
    expect(f([{ propId: 'tg', op: 'contains', value: 'Short' }])).toEqual(['Écran géant', 'arbre secret']);
    expect(f([{ propId: 'tg', op: 'not_contains', value: 'Tuto' }]).length).toBe(3);
    expect(f([{ propId: 'ok', op: 'checked' }])).toEqual(['Écran géant']);
    expect(f([{ propId: 'ok', op: 'unchecked' }]).length).toBe(3);
    expect(f([{ propId: 'who', op: 'contains', value: 'p2' }])).toEqual(['Base Roblox 10']);
    expect(f([{ propId: 'who', op: 'contains', value: 'Léa' }])).toEqual(['Écran géant']);
  });
  it('dates relatives et absolues (plages incluses)', () => {
    expect(f([{ propId: 'd', op: 'today' }])).toEqual(['Écran géant']);
    expect(f([{ propId: 'd', op: 'this_week' }])).toEqual(['Écran géant', 'Base Roblox 10', 'Base Roblox 2']);
    expect(f([{ propId: 'd', op: 'before', value: '2026-11-03' }])).toEqual(['Base Roblox 10']);
    expect(f([{ propId: 'd', op: 'after', value: '2026-11-04' }])).toEqual(['arbre secret']);
    expect(f([{ propId: 'd', op: 'is', value: '2026-11-01' }])).toEqual(['Base Roblox 10']);
    expect(f([{ propId: 'd', op: 'next_days', value: 30 }])).toEqual(['Écran géant', 'arbre secret']);
    expect(f([{ propId: 'd', op: 'past' }])).toEqual(['Base Roblox 10', 'Base Roblox 2']);
  });
  it('formules filtrées comme des nombres', () => {
    expect(f([{ propId: 'f', op: 'gte', value: 50 }])).toEqual(['Écran géant', 'Base Roblox 2']);
  });
  it('mode ET / OU et règles incomplètes ignorées', () => {
    expect(f([{ propId: 'st', op: 'is', value: 'Script' }, { propId: 'v', op: 'gt', value: 1000 }])).toEqual(['Base Roblox 2']);
    expect(f([{ propId: 'st', op: 'is', value: 'Idée' }, { propId: 'ok', op: 'checked' }], 'or')).toEqual(['Écran géant', 'arbre secret']);
    expect(f([{ propId: 'title', op: 'contains', value: '' }]).length).toBe(4);
    expect(f([{ propId: 'inconnue', op: 'is', value: 'x' }]).length).toBe(4);
  });
  it('recherche', () => {
    expect(titles(applySearch(rows, 'roblox', ctx))).toEqual(['Base Roblox 10', 'Base Roblox 2']);
    expect(titles(applySearch(rows, 'tuto', ctx))).toEqual(['arbre secret']);
  });
});

describe('tris', () => {
  const sorted = (sorts: { propId: string; dir: 'asc' | 'desc' }[]) => titles(applySorts(rows, sorts, ctx));
  it('par titre (ordre naturel, accents)', () => {
    expect(sorted([{ propId: 'title', dir: 'asc' }])).toEqual(['arbre secret', 'Base Roblox 2', 'Base Roblox 10', 'Écran géant']);
  });
  it('par nombre, vides en dernier dans les deux sens', () => {
    expect(sorted([{ propId: 'v', dir: 'asc' }])).toEqual(['arbre secret', 'Base Roblox 2', 'Écran géant', 'Base Roblox 10']);
    expect(sorted([{ propId: 'v', dir: 'desc' }])).toEqual(['Écran géant', 'Base Roblox 2', 'arbre secret', 'Base Roblox 10']);
  });
  it('par statut selon l’ordre des options, puis tri secondaire', () => {
    expect(sorted([{ propId: 'st', dir: 'asc' }, { propId: 'v', dir: 'desc' }])).toEqual(['arbre secret', 'Base Roblox 2', 'Base Roblox 10', 'Écran géant']);
  });
  it('par date', () => {
    expect(sorted([{ propId: 'd', dir: 'desc' }])).toEqual(['arbre secret', 'Écran géant', 'Base Roblox 2', 'Base Roblox 10']);
  });
  it('sans tri : ordre manuel', () => {
    expect(sorted([])).toEqual(titles(rows));
  });
});

describe('groupement, pré-remplissage et calculs', () => {
  it('groupe par statut avec groupe vide en tête', () => {
    const g = groupRows(rows, s.properties.find(p => p.id === 'st')!, ctx);
    expect(g.map(x => [x.label, x.rows.length])).toEqual([['Sans statut', 0], ['Idée', 1], ['Script', 2], ['Publié', 1]]);
    expect(groupRows(rows, s.properties.find(p => p.id === 'st')!, ctx, { hideEmpty: true }).length).toBe(3);
  });
  it('groupe par sélection multiple, case et personne', () => {
    expect(groupRows(rows, s.properties.find(p => p.id === 'tg')!, ctx).map(x => x.rows.length)).toEqual([2, 2, 1]);
    expect(groupRows(rows, s.properties.find(p => p.id === 'ok')!, ctx).map(x => x.rows.length)).toEqual([1, 3]);
    expect(groupRows(rows, s.properties.find(p => p.id === 'who')!, ctx).map(x => x.label)).toEqual(['Aucune personne', 'Léa', 'Hugo']);
  });
  it('valeur écrite lors d’un déplacement entre groupes', () => {
    const st = s.properties.find(p => p.id === 'st')!;
    expect(valueForGroup(st, 'Publié', 'Idée')).toBe('Publié');
    expect(valueForGroup(s.properties.find(p => p.id === 'tg')!, 'Tuto', ['Short'])).toEqual(['Short', 'Tuto']);
  });
  it('pré-remplit depuis les filtres', () => {
    expect(prefillFromFilters({ filters: [{ propId: 'st', op: 'is', value: 'b' }, { propId: 'ok', op: 'checked' }] }, ctx)).toEqual({ st: 'Script', ok: true });
  });
  it('calcule le pied de tableau', () => {
    const v = s.properties.find(p => p.id === 'v')!;
    expect(computeCalc('sum', rows, v, ctx)).toBe('17 300');
    expect(computeCalc('avg', rows, v, ctx)).toBe('5 766,666667');
    expect(computeCalc('count_empty', rows, v, ctx)).toBe('1');
    expect(computeCalc('percent_not_empty', rows, v, ctx)).toBe('75 %');
    expect(computeCalc('checked', rows, s.properties.find(p => p.id === 'ok')!, ctx)).toBe('1');
    expect(computeCalc('count_unique', rows, s.properties.find(p => p.id === 'tg')!, ctx)).toBe('2');
  });
});
