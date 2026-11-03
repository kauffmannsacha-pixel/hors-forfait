import { describe, expect, it } from 'vitest';
import { planConversion } from '../convert';
import type { PropDef } from '../model';
import { ctxOf, row, schema } from './helpers';

const text: PropDef = { id: 'x', name: 'Champ', type: 'text' };
const s = schema('db', [text]);
const rows = [row('db', 'A', { x: '12,5' }), row('db', 'B', { x: 'Tuto, Short' }), row('db', 'C', { x: 'oui' }), row('db', 'D', { x: '03/11/2026' }), row('db', 'E', {})];
const ctx = ctxOf(s, rows);
const valueOf = (plan: ReturnType<typeof planConversion>, id: string) => plan.values.find(v => v.rowId === id)?.value;

describe('conversion de types', () => {
  it('texte → nombre', () => {
    const p = planConversion(text, 'number', rows, ctx);
    expect(valueOf(p, rows[0].id)).toBe(12.5);
    expect(valueOf(p, rows[1].id)).toBeNull();
    expect(p.lossy).toBe(true);
  });
  it('texte → sélection multiple : crée les options', () => {
    const p = planConversion(text, 'multi_select', rows, ctx);
    expect(valueOf(p, rows[1].id)).toEqual(['Tuto', 'Short']);
    expect(p.prop.options!.map(o => o.name)).toEqual(['12', '5', 'Tuto', 'Short', 'oui', '03/11/2026']);
    expect(new Set(p.prop.options!.map(o => o.color)).size).toBeGreaterThan(3);
  });
  it('texte → case à cocher', () => {
    const p = planConversion(text, 'checkbox', rows, ctx);
    expect(valueOf(p, rows[2].id)).toBe(true);
    expect(valueOf(p, rows[0].id)).toBe(false);
  });
  it('texte → date', () => {
    const p = planConversion(text, 'date', rows, ctx);
    expect(valueOf(p, rows[3].id)).toBe('2026-11-03');
  });
  it('sélection → sélection multiple → texte, options conservées', () => {
    const sel: PropDef = { id: 's', name: 'Statut', type: 'select', options: [{ id: 'o1', name: 'Idée', color: 'gray' }, { id: 'o2', name: 'Publié', color: 'green' }] };
    const s2 = schema('db2', [sel]);
    const r2 = [row('db2', 'A', { s: 'Publié' }), row('db2', 'B', { s: 'o1' })];
    const c2 = ctxOf(s2, r2);
    const toMulti = planConversion(sel, 'multi_select', r2, c2);
    expect(toMulti.prop.options).toEqual(sel.options);
    expect(valueOf(toMulti, r2[0].id)).toEqual(['Publié']);
    expect(valueOf(toMulti, r2[1].id)).toEqual(['Idée']);
    const toText = planConversion(sel, 'text', r2, c2);
    expect(valueOf(toText, r2[1].id)).toBe('Idée');
    expect(toText.prop.options).toBeUndefined();
    const toStatus = planConversion(sel, 'status', r2, c2);
    expect(toStatus.prop.options).toEqual(sel.options);
  });
  it('case à cocher → texte, nombre → case', () => {
    const cb: PropDef = { id: 'c', name: 'Fait', type: 'checkbox' };
    const nb: PropDef = { id: 'n', name: 'N', type: 'number' };
    const s3 = schema('db3', [cb, nb]);
    const r3 = [row('db3', 'A', { c: true, n: 0 }), row('db3', 'B', { c: false, n: 3 })];
    const c3 = ctxOf(s3, r3);
    expect(planConversion(cb, 'text', r3, c3).values.map(v => v.value)).toEqual(['Oui', 'Non']);
    expect(planConversion(nb, 'checkbox', r3, c3).values.map(v => v.value)).toEqual([false, true]);
  });
  it('texte → personne : crée les personnes manquantes', () => {
    const p = planConversion(text, 'person', [row('db', 'A', { x: 'Léa, Hugo' })], ctxOf(s, [], [], [{ id: 'lea', name: 'léa', color: 'blue' }]));
    expect(p.newPeople.map(x => x.name)).toEqual(['Hugo']);
    expect((p.values[0].value as string[])[0]).toBe('lea');
  });
  it('vers une formule : valeurs supprimées et perte signalée', () => {
    const p = planConversion(text, 'formula', rows, ctx);
    expect(p.values.every(v => v.value === undefined)).toBe(true);
    expect(p.lossy).toBe(true);
    expect(p.prop.formula).toBe('');
  });
});
