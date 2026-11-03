import { describe, expect, it } from 'vitest';
import { computed, displayValue, formulaValue } from '../engine';
import { relationDiff } from '../relations';
import type { Schema } from '../model';
import { ctxOf, row, schema } from './helpers';

// Base « Partenariats » liée à « Vidéos » (relation) avec rollups.
const videos: Schema = schema('vid', [
  { id: 'vues', name: 'Vues', type: 'number' },
  { id: 'rev', name: 'Revenu', type: 'number', numberFormat: 'euro' },
  { id: 'pub', name: 'Publication', type: 'date' },
  { id: 'fmt', name: 'Format', type: 'select', options: [{ id: 'a', name: 'Short', color: 'red' }, { id: 'b', name: 'Long', color: 'blue' }] },
]);
const partners: Schema = schema('par', [
  { id: 'rel', name: 'Vidéos', type: 'relation', relation: { databaseId: 'vid', syncedPropId: 'back' } },
  { id: 'n', name: 'Nb vidéos', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: '', fn: 'count' } },
  { id: 's', name: 'Vues totales', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: 'vues', fn: 'sum' } },
  { id: 'a', name: 'Moyenne', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: 'vues', fn: 'avg' } },
  { id: 'mi', name: 'Min', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: 'vues', fn: 'min' } },
  { id: 'ma', name: 'Dernière', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: 'pub', fn: 'max' } },
  { id: 'sh', name: 'Formats', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: 'fmt', fn: 'show' } },
  { id: 'r', name: 'Revenus', type: 'rollup', rollup: { relationPropId: 'rel', targetPropId: 'rev', fn: 'sum' } },
  { id: 'f', name: 'Résumé', type: 'formula', formula: 'prop("Nb vidéos") + " vidéos, " + prop("Vues totales") + " vues"' },
]);
const v1 = row('vid', 'Vidéo 1', { vues: 1000, rev: 120.5, pub: '2026-10-01', fmt: 'Short' });
const v2 = row('vid', 'Vidéo 2', { vues: 3000, rev: 80, pub: '2026-11-02', fmt: 'Long' });
const v3 = row('vid', 'Vidéo 3', { vues: 500 }, { trashed: true });
const p1 = row('par', 'Marque X', { rel: [v1.id, v2.id, v3.id] });
const p2 = row('par', 'Marque Y', {});
const ctx = ctxOf(partners, [v1, v2, v3, p1, p2], [videos]);
const prop = (id: string) => partners.properties.find(p => p.id === id)!;

describe('rollups', () => {
  it('count / sum / avg / min ignorent les lignes supprimées', () => {
    expect(formulaValue(p1, prop('n'), ctx)).toBe(2);
    expect(formulaValue(p1, prop('s'), ctx)).toBe(4000);
    expect(formulaValue(p1, prop('a'), ctx)).toBe(2000);
    expect(formulaValue(p1, prop('mi'), ctx)).toBe(1000);
  });
  it('max sur des dates renvoie une date', () => {
    const d = formulaValue(p1, prop('ma'), ctx) as Date;
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(2);
  });
  it('show liste les valeurs', () => {
    expect(formulaValue(p1, prop('sh'), ctx)).toEqual(['Short', 'Long']);
    expect(displayValue(p1, prop('sh'), ctx)).toBe('Short, Long');
  });
  it('reprend le format numérique de la cible', () => {
    expect(displayValue(p1, prop('r'), ctx)).toBe('200,50 €');
  });
  it('relation vide', () => {
    expect(formulaValue(p2, prop('n'), ctx)).toBe(0);
    expect(formulaValue(p2, prop('s'), ctx)).toBe(0);
    expect(formulaValue(p2, prop('a'), ctx)).toBeNull();
  });
  it('utilisable dans une formule', () => {
    expect(formulaValue(p1, prop('f'), ctx)).toBe('2 vidéos, 4000 vues');
  });
  it('erreur lisible si mal configuré', () => {
    const bad = { ...prop('s'), id: 'bad', rollup: { relationPropId: 'zzz', targetPropId: 'vues', fn: 'sum' as const } };
    const r = computed(p1, bad, ctx);
    expect('error' in r && r.error).toMatch(/relation n’existe plus/);
  });
});

describe('relations bidirectionnelles', () => {
  it('calcule les ajouts et retraits', () => {
    expect(relationDiff(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(relationDiff(undefined, ['x'])).toEqual({ added: ['x'], removed: [] });
  });
});
