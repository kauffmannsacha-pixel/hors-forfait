// ─────────────────────────────────────────────────────────────
// CONTRAT Bases de données — implémenté/enrichi par le module database.
// Utilisé par : connecteurs (Stripe, Discord), mail, publication, studio, Claude.
// Une base = Page kind 'database' + schéma (kv `db:<id>`). Une ligne = Page enfant avec props.
// ─────────────────────────────────────────────────────────────
import { repo, uid } from '../db/store';
import { allPages, createPage, getPage, updatePage } from '../db/pages';
import type { DatabaseSchema, ID, Page, PropertyDef } from '../db/types';

export const getSchema = (dbId: ID) => repo.kvGet<DatabaseSchema>('db:' + dbId);
export const saveSchema = (s: DatabaseSchema) => repo.kvSet('db:' + s.id, s);

export async function createDatabase(init: { title: string; icon?: string; parentId?: ID | null; properties: Omit<PropertyDef, 'id'>[]; views?: DatabaseSchema['views'] }): Promise<ID> {
  const page = await createPage({ title: init.title, icon: init.icon, parentId: init.parentId ?? null, kind: 'database' });
  const props: PropertyDef[] = init.properties.map(p => ({ ...p, id: p.type === 'title' ? 'title' : uid().slice(0, 8), options: p.options?.map(o => ({ ...o, id: o.id || uid().slice(0, 8) })) }));
  if (!props.some(p => p.type === 'title')) props.unshift({ id: 'title', name: 'Nom', type: 'title' });
  await saveSchema({ id: page.id, properties: props, views: init.views ?? [{ id: uid().slice(0, 8), name: 'Tableau', type: 'table', filters: [], sorts: [] }] });
  return page.id;
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
  const title = String(props.title ?? values['title'] ?? values['Nom'] ?? '');
  return createPage({ parentId: dbId, title, props, kind: 'page', ...(content ? { content } : {}) });
}
export async function updateRow(rowId: ID, values: Record<string, unknown>) {
  const row = getPage(rowId); if (!row?.parentId) return;
  const props = { ...(row.props ?? {}), ...(await resolveProps(row.parentId, values)) };
  return updatePage(rowId, { props, ...(props.title !== undefined ? { title: String(props.title) } : {}) });
}
/** Lecture d'une valeur par nom ou id de propriété. */
export async function rowValue(row: Page, prop: string): Promise<unknown> {
  if (!row.parentId) return undefined;
  const s = await getSchema(row.parentId); const def = s?.properties.find(p => p.id === prop || p.name === prop);
  return def ? (def.id === 'title' ? row.title : row.props?.[def.id]) : undefined;
}
async function resolveProps(dbId: ID, values: Record<string, unknown>) {
  const s = await getSchema(dbId); const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const def = s?.properties.find(p => p.id === k || p.name === k);
    out[def?.id ?? k] = v;
  }
  return out;
}
