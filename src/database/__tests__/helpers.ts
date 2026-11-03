// Fabrique de bases en mémoire pour les tests.
import type { Page } from '../../db/types';
import { makeCtx, type EngineCtx } from '../engine';
import type { Person, PropDef, Schema } from '../model';

let n = 0;
export function row(dbId: string, title: string, props: Record<string, unknown> = {}, extra: Partial<Page> = {}): Page {
  n++;
  return { id: extra.id ?? `r${n}`, parentId: dbId, title, content: null, props, favorite: false, trashed: false, kind: 'page', createdAt: 1_700_000_000_000 + n, updatedAt: 1_700_000_000_000 + n, order: n, ...extra };
}
export function schema(id: string, properties: PropDef[]): Schema {
  return { id, properties: [{ id: 'title', name: 'Nom', type: 'title' }, ...properties], views: [{ id: 'v', name: 'Tableau', type: 'table', filters: [], sorts: [] }] };
}
export function ctxOf(main: Schema, pages: Page[], others: Schema[] = [], people: Person[] = [], now = new Date(2026, 10, 4, 10, 0)): EngineCtx {
  const byId = new Map(pages.map(p => [p.id, p]));
  const schemas = new Map([main, ...others].map(s => [s.id, s]));
  return makeCtx(main, { getSchema: id => schemas.get(id), getPage: id => byId.get(id), people, now });
}
