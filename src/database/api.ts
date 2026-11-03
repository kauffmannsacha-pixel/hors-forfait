// ─────────────────────────────────────────────────────────────
// CONTRAT Bases de données — implémenté/enrichi par le module database.
// Utilisé par : connecteurs (Stripe, Discord), mail, publication, studio, Claude.
// Une base = Page kind 'database' + schéma (kv `db:<id>`). Une ligne = Page enfant avec props.
//
// Valeurs stockées (page.props[idPropriété]) :
//  texte/url/email/téléphone : string · nombre : number · sélection/statut : NOM de l'option (string)
//  sélection multiple : string[] (noms) · date : 'yyyy-MM-dd' | "yyyy-MM-dd'T'HH:mm" | { start, end }
//  personne : string[] (ids kv 'people') · case : boolean · fichier : { hash?, url?, name, mime? }[]
//  relation : string[] (ids des lignes liées) · formule / rollup / créé le / modifié le : calculés.
// addRow / updateRow acceptent des valeurs « libres » (noms d'options, Date, timestamps, noms de personnes,
// titres de lignes liées…) et les normalisent ; les options manquantes sont créées automatiquement.
// ─────────────────────────────────────────────────────────────
import { allPages, getPage, trashPage, usePages } from '../db/pages';
import type { DatabaseSchema, FilterRule, ID, Page, PropertyDef, SortRule } from '../db/types';
import { coerceInput } from './coerce';
import { engineFor, liveRows } from './ctx';
import { displayValue, plainValue, type EngineCtx } from './engine';
import { createDatabaseRaw, createRow, mutateSchema, setValues } from './mutations';
import { findProp, type Person, type PropDef, type Schema } from './model';
import { addPeople, loadPeople } from './people';
import { applyFilters, applySearch, applySorts } from './query';
import { loadSchema, normalizeSchema, putSchema } from './schemaStore';

/** Schéma d'une base (copie : la modifier n'a pas d'effet tant qu'on n'appelle pas saveSchema). */
export const getSchema = async (dbId: ID): Promise<DatabaseSchema | undefined> => {
  const s = await loadSchema(dbId);
  return s ? structuredClone(s) : undefined;
};
export const saveSchema = (s: DatabaseSchema): Promise<void> => putSchema(normalizeSchema(s, s.id));

export async function createDatabase(init: { title: string; icon?: string; parentId?: ID | null; properties: Omit<PropertyDef, 'id'>[]; views?: DatabaseSchema['views'] }): Promise<ID> {
  return createDatabaseRaw({ title: init.title, icon: init.icon, parentId: init.parentId ?? null, properties: init.properties, views: init.views });
}
/** Trouve une base par titre (ou la crée avec ce schéma). Pratique pour les connecteurs. */
export async function ensureDatabase(title: string, init: Omit<Parameters<typeof createDatabase>[0], 'title'>): Promise<ID> {
  const found = allPages().find(p => p.kind === 'database' && p.title === title && !p.trashed);
  return found ? found.id : createDatabase({ title, ...init });
}
export const rowsOf = (dbId: ID): Page[] => allPages().filter(p => p.parentId === dbId && !p.trashed).sort((a, b) => a.order - b.order);
/** Valeurs indexées par NOM de propriété (plus simple pour les autres modules) ou par id. */
export async function addRow(dbId: ID, values: Record<string, unknown>, content?: unknown): Promise<Page> {
  const props = await resolveProps(dbId, values);
  const { title, ...rest } = props;
  return createRow(dbId, { title: String(title ?? values['title'] ?? values['Nom'] ?? ''), props: rest, ...(content ? { content } : {}) });
}
export async function updateRow(rowId: ID, values: Record<string, unknown>) {
  const row = getPage(rowId); if (!row?.parentId) return;
  const props = await resolveProps(row.parentId, values);
  await setValues(rowId, props);
  return getPage(rowId);
}
/** Lecture d'une valeur par nom ou id de propriété (valeur brute stockée). */
export async function rowValue(row: Page, prop: string): Promise<unknown> {
  if (!row.parentId) return undefined;
  const s = await getSchema(row.parentId); const def = s?.properties.find(p => p.id === prop || p.name === prop);
  return def ? (def.id === 'title' ? row.title : row.props?.[def.id]) : undefined;
}
async function resolveProps(dbId: ID, values: Record<string, unknown>) {
  const s = await loadSchema(dbId);
  const out: Record<string, unknown> = {};
  if (!s) { for (const [k, v] of Object.entries(values)) out[k] = v; return out; }
  const people = await loadPeople();
  const newPeople: Person[] = [];
  const newOptions: Record<string, PropDef['options']> = {};
  for (const [k, v] of Object.entries(values)) {
    const def = findProp(s, k);
    if (!def) { out[k] = v; continue; }
    if (def.type === 'title') { out.title = v === null || v === undefined ? '' : String(v); continue; }
    const r = coerceInput({ ...def, ...(newOptions[def.id] ? { options: newOptions[def.id] } : {}) }, v, { people: [...people, ...newPeople], rowsOf: liveRows });
    if (r.skip) continue;
    out[def.id] = r.value;
    if (r.options) newOptions[def.id] = r.options;
    if (r.newPeople) newPeople.push(...r.newPeople);
  }
  if (newPeople.length) await addPeople(newPeople);
  if (Object.keys(newOptions).length) {
    await mutateSchema(dbId, x => { for (const p of x.properties) if (newOptions[p.id]) p.options = newOptions[p.id]; });
  }
  return out;
}

// ── Ajouts (module database) ─────────────────────────────────
export { createFromTemplate, databaseTemplates, ensureFromTemplate } from './templates';
export { readDate, writeDate } from './dates';

/** Bases de données existantes (hors corbeille). */
export const listDatabases = (): Page[] =>
  Object.values(usePages.getState().pages).filter(p => p.kind === 'database' && !p.trashed).sort((a, b) => a.order - b.order);

/** Trouve une base par id ou par titre (insensible à la casse). */
export function findDatabase(ref: string): Page | undefined {
  const dbs = listDatabases();
  const key = ref.trim().toLowerCase();
  return dbs.find(d => d.id === ref) ?? dbs.find(d => d.title.trim().toLowerCase() === key);
}

/** Valeurs lisibles d'une ligne, indexées par NOM de propriété (options en clair, dates ISO, titres liés…). */
export async function rowValues(row: Page): Promise<Record<string, unknown>> {
  if (!row.parentId) return {};
  const ctx = await engineFor(row.parentId);
  if (!ctx) return {};
  return Object.fromEntries(ctx.schema.properties.map(p => [p.name, plainValue(row, p, ctx)]));
}

/** Texte d'affichage d'une cellule (« 1 200,00 € », « 3 nov. 2026 »…). */
export async function rowDisplay(row: Page, prop: string): Promise<string> {
  if (!row.parentId) return '';
  const ctx = await engineFor(row.parentId);
  const def = ctx && findProp(ctx.schema, prop);
  return ctx && def ? displayValue(row, def, ctx) : '';
}

export interface RowQuery {
  /** Filtres par nom ou id de propriété ; op : is, is_not, contains, gt, lt, before, after, this_week, empty… */
  filters?: { property: string; op: string; value?: unknown }[];
  filterMode?: 'and' | 'or';
  sorts?: { property: string; dir?: 'asc' | 'desc' }[];
  search?: string;
  limit?: number;
}
/** Requête sur les lignes d'une base (mêmes filtres/tris que l'interface). */
export async function queryRows(dbId: ID, q: RowQuery = {}): Promise<{ rows: Page[]; ctx: EngineCtx }> {
  const ctx = await engineFor(dbId);
  if (!ctx) throw new Error('Base de données introuvable');
  const filters: FilterRule[] = (q.filters ?? []).map(f => {
    const p = findProp(ctx.schema as Schema, f.property);
    if (!p) throw new Error(`Propriété inconnue : « ${f.property} »`);
    return { propId: p.id, op: f.op, value: f.value };
  });
  const sorts: SortRule[] = (q.sorts ?? []).map(s => {
    const p = findProp(ctx.schema as Schema, s.property);
    if (!p) throw new Error(`Propriété inconnue : « ${s.property} »`);
    return { propId: p.id, dir: s.dir === 'desc' ? 'desc' : 'asc' };
  });
  let rows = applyFilters(liveRows(dbId), { filters, filterMode: q.filterMode }, ctx);
  if (q.search) rows = applySearch(rows, q.search, ctx);
  rows = applySorts(rows, sorts, ctx);
  return { rows: q.limit ? rows.slice(0, q.limit) : rows, ctx };
}

/** Met une ligne à la corbeille (restaurable). */
export const deleteRow = (rowId: ID) => trashPage(rowId);
