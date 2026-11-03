// Actions sur les bases : schéma (propriétés, options, vues), lignes (création, valeurs, ordre, suppression).
import { createPage, getPage, restorePage, trashPage, updatePage } from '../db/pages';
import type { DbViewType, ID, Page, PropertyType, SelectOption } from '../db/types';
import { toast, toastAction } from '../ui/appState';
import { planConversion } from './convert';
import { engineFor, liveRows } from './ctx';
import { asList, asText } from './engine';
import { renamePropInFormula } from './formula';
import {
  COLORS, DEFAULT_STATUS, isComputed, newId, nextColor, TYPE_LABELS, uniqueName, VIEW_LABELS,
  type ColorName, type PropDef, type Schema, type ViewX,
} from './model';
import { addPeople } from './people';
import { BOARDABLE, GROUPABLE } from './query';
import { mirrorValue, relationDiff } from './relations';
import { cachedSchema, loadSchema, normalizeSchema, putSchema } from './schemaStore';

// ── Schéma ───────────────────────────────────────────────────
export async function mutateSchema(dbId: ID, fn: (s: Schema) => void | Schema): Promise<Schema> {
  const cur = cachedSchema(dbId) ?? await loadSchema(dbId);
  if (!cur) throw new Error('Base de données introuvable');
  const draft = structuredClone(cur);
  const next = fn(draft) ?? draft;
  await putSchema(next);
  return cachedSchema(dbId) ?? next;
}

/** Crée une base (page kind 'database' + schéma). Les ids de propriétés fournis sont conservés. */
export async function createDatabaseRaw(init: {
  title: string; icon?: string; parentId?: ID | null; properties: (Omit<PropDef, 'id'> & { id?: string })[];
  views?: ViewX[]; meta?: Record<string, unknown>;
}): Promise<ID> {
  const page = await createPage({ title: init.title, icon: init.icon, parentId: init.parentId ?? null, kind: 'database', ...(init.meta ? { meta: init.meta } : {}) });
  const props: PropDef[] = init.properties.map(p => ({
    ...p, id: p.type === 'title' ? 'title' : p.id || newId(),
    ...(p.options ? { options: p.options.map(o => ({ ...o, id: o.id || newId() })) } : {}),
  }));
  if (!props.some(p => p.type === 'title')) props.unshift({ id: 'title', name: 'Nom', type: 'title' });
  const schema = normalizeSchema({ id: page.id, properties: props, views: init.views ?? [] }, page.id);
  await putSchema(schema);
  return page.id;
}

/** Configuration par défaut d'une nouvelle vue selon sa disposition. */
export function defaultViewConfig(schema: Schema, type: DbViewType): Partial<ViewX> {
  const first = (types: PropertyType[]) => schema.properties.find(p => types.includes(p.type));
  const cardHidden = (keep: (string | undefined)[]) => {
    const shown = new Set(keep.filter(Boolean) as string[]);
    const extras = schema.properties.filter(p => ['status', 'select', 'date', 'person'].includes(p.type) && !shown.has(p.id)).slice(0, 3);
    extras.forEach(p => shown.add(p.id));
    return schema.properties.filter(p => p.id !== 'title' && !shown.has(p.id)).map(p => p.id);
  };
  switch (type) {
    case 'board': {
      const g = first(['status']) ?? first(['select']) ?? first(['person']) ?? first(['checkbox']);
      return { groupBy: g?.id, hiddenProps: [...cardHidden([]), ...(g ? [g.id] : [])], cover: 'none', cardSize: 'medium' };
    }
    case 'calendar': return { dateProp: first(['date'])?.id, hiddenProps: schema.properties.filter(p => p.id !== 'title').map(p => p.id) };
    case 'timeline': return { dateProp: first(['date'])?.id, zoom: 'week', hiddenProps: schema.properties.filter(p => p.id !== 'title').map(p => p.id) };
    case 'gallery': return { cover: first(['file'])?.id ?? 'page', cardSize: 'medium', hiddenProps: cardHidden([]) };
    case 'list': return { hiddenProps: cardHidden([]) };
    default: return {};
  }
}

export async function addView(dbId: ID, type: DbViewType, name?: string): Promise<ViewX> {
  let view!: ViewX;
  await mutateSchema(dbId, s => {
    view = { id: newId(), name: name ?? uniqueName(VIEW_LABELS[type], s.views.map(v => v.name)), type, filters: [], sorts: [], ...defaultViewConfig(s, type) };
    s.views.push(view);
  });
  return view;
}
export const updateView = (dbId: ID, viewId: string, patch: Partial<ViewX> | ((v: ViewX) => Partial<ViewX>)) =>
  mutateSchema(dbId, s => {
    const i = s.views.findIndex(v => v.id === viewId); if (i < 0) return;
    const p = typeof patch === 'function' ? patch(s.views[i]) : patch;
    s.views[i] = { ...s.views[i], ...p };
  });
export async function duplicateView(dbId: ID, viewId: string): Promise<ViewX | undefined> {
  let copy: ViewX | undefined;
  await mutateSchema(dbId, s => {
    const i = s.views.findIndex(v => v.id === viewId); if (i < 0) return;
    copy = { ...structuredClone(s.views[i]), id: newId(), name: uniqueName(`${s.views[i].name} (copie)`, s.views.map(v => v.name)) };
    s.views.splice(i + 1, 0, copy);
  });
  return copy;
}
export const deleteView = (dbId: ID, viewId: string) => mutateSchema(dbId, s => {
  if (s.views.length <= 1) throw new Error('Une base doit garder au moins une vue');
  s.views = s.views.filter(v => v.id !== viewId);
});
export const moveView = (dbId: ID, from: number, to: number) => mutateSchema(dbId, s => {
  const [v] = s.views.splice(from, 1); if (v) s.views.splice(to, 0, v);
});

// ── Propriétés ───────────────────────────────────────────────
export async function addProperty(dbId: ID, init: Partial<PropDef> & { type: PropertyType }, opts: { viewId?: string; afterPropId?: string; before?: boolean } = {}): Promise<PropDef> {
  let prop!: PropDef;
  await mutateSchema(dbId, s => {
    const names = s.properties.map(p => p.name);
    prop = {
      ...init, id: newId(), type: init.type, name: uniqueName(init.name?.trim() || TYPE_LABELS[init.type], names),
    };
    if (prop.type === 'status' && !prop.options?.length) prop.options = DEFAULT_STATUS.map(o => ({ ...o, id: newId() }));
    if ((prop.type === 'select' || prop.type === 'multi_select') && !prop.options) prop.options = [];
    if (prop.type === 'number' && !prop.numberFormat) prop.numberFormat = 'number';
    if (prop.type === 'formula' && prop.formula === undefined) prop.formula = '';
    if (prop.type === 'rollup' && !prop.rollup) {
      const rel = s.properties.find(p => p.type === 'relation');
      prop.rollup = { relationPropId: rel?.id ?? '', targetPropId: '', fn: 'count' };
    }
    const idx = opts.afterPropId ? s.properties.findIndex(p => p.id === opts.afterPropId) : -1;
    if (idx >= 0) s.properties.splice(opts.before ? idx : idx + 1, 0, prop); else s.properties.push(prop);
    for (const v of s.views) {
      if (v.propOrder?.length && opts.afterPropId) {
        const i = v.propOrder.indexOf(opts.afterPropId);
        if (i >= 0) v.propOrder.splice(opts.before ? i : i + 1, 0, prop.id); else v.propOrder.push(prop.id);
      } else if (v.propOrder?.length) v.propOrder.push(prop.id);
      // Les vues « cartes » n'affichent pas automatiquement les nouvelles propriétés (sauf la vue courante).
      if (v.type !== 'table' && v.id !== opts.viewId) v.hiddenProps = [...(v.hiddenProps ?? []), prop.id];
    }
  });
  return prop;
}

export async function updateProperty(dbId: ID, propId: string, patch: Partial<PropDef>) {
  return mutateSchema(dbId, s => {
    const p = s.properties.find(x => x.id === propId); if (!p) return;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('Le nom de la propriété ne peut pas être vide');
      if (s.properties.some(x => x.id !== propId && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Une propriété « ${name} » existe déjà`);
      if (name !== p.name) for (const f of s.properties) if (f.type === 'formula' && f.formula) f.formula = renamePropInFormula(f.formula, p.name, name);
      patch = { ...patch, name };
    }
    Object.assign(p, patch);
  });
}

function cleanViewsFor(s: Schema, propId: string, keepSorts = false) {
  for (const v of s.views) {
    v.filters = v.filters.filter(f => f.propId !== propId);
    if (!keepSorts) v.sorts = v.sorts.filter(x => x.propId !== propId);
    if (v.groupBy === propId) v.groupBy = undefined;
    if (v.dateProp === propId) v.dateProp = undefined;
    if (v.endDateProp === propId) v.endDateProp = undefined;
    if (v.cover === propId) v.cover = 'page';
    if (v.calcs) delete v.calcs[propId];
    if (!keepSorts) {
      v.hiddenProps = v.hiddenProps?.filter(x => x !== propId);
      v.propOrder = v.propOrder?.filter(x => x !== propId);
      if (v.widths) delete v.widths[propId];
    }
  }
}

async function unlinkMirror(prop: PropDef) {
  const conf = prop.relation;
  if (!conf?.syncedPropId || !conf.databaseId) return;
  await mutateSchema(conf.databaseId, t => {
    const m = t.properties.find(p => p.id === conf.syncedPropId);
    if (m?.relation?.syncedPropId === prop.id) delete m.relation.syncedPropId;
  }).catch(() => undefined);
}

async function clearValues(dbId: ID, propId: string) {
  for (const r of liveRows(dbId)) {
    if (r.props && propId in r.props) {
      const props = { ...r.props }; delete props[propId];
      await updatePage(r.id, { props });
    }
  }
}

export async function deleteProperty(dbId: ID, propId: string) {
  if (propId === 'title') throw new Error('Le titre ne peut pas être supprimé');
  const prop = cachedSchema(dbId)?.properties.find(p => p.id === propId);
  await mutateSchema(dbId, s => { s.properties = s.properties.filter(p => p.id !== propId); cleanViewsFor(s, propId); });
  if (prop) await unlinkMirror(prop);
  await clearValues(dbId, propId);
}

export async function duplicateProperty(dbId: ID, propId: string): Promise<PropDef | undefined> {
  const s = cachedSchema(dbId) ?? await loadSchema(dbId);
  const src = s?.properties.find(p => p.id === propId);
  if (!src || src.type === 'title') return;
  const { id: _id, ...rest } = structuredClone(src);
  if (rest.relation) delete rest.relation.syncedPropId;
  const copy = await addProperty(dbId, { ...rest, name: `${src.name} (copie)` }, { afterPropId: propId });
  for (const r of liveRows(dbId)) {
    const v = r.props?.[propId];
    if (v !== undefined) await updatePage(r.id, { props: { ...r.props, [copy.id]: structuredClone(v) } });
  }
  return copy;
}

/** Change le type d'une propriété et convertit les valeurs existantes. */
export async function changePropertyType(dbId: ID, propId: string, type: PropertyType) {
  const ctx = await engineFor(dbId);
  const from = ctx?.schema.properties.find(p => p.id === propId);
  if (!ctx || !from || from.type === type) return;
  if (from.type === 'title' || type === 'title') throw new Error('Le type du titre ne peut pas être changé');
  const plan = planConversion(from, type, liveRows(dbId), ctx);
  if (from.type === 'relation') await unlinkMirror(from);
  await addPeople(plan.newPeople);
  await mutateSchema(dbId, s => {
    const i = s.properties.findIndex(p => p.id === propId); if (i < 0) return;
    s.properties[i] = plan.prop;
    for (const v of s.views) {
      v.filters = v.filters.filter(f => f.propId !== propId);
      if (v.calcs) delete v.calcs[propId];
      if (v.groupBy === propId && !(v.type === 'board' ? BOARDABLE : GROUPABLE).includes(type)) v.groupBy = undefined;
      if ((v.dateProp === propId || v.endDateProp === propId) && type !== 'date') { if (v.dateProp === propId) v.dateProp = undefined; if (v.endDateProp === propId) v.endDateProp = undefined; }
    }
  });
  for (const { rowId, value } of plan.values) {
    const r = getPage(rowId); if (!r) continue;
    const props = { ...(r.props ?? {}) };
    if (value === undefined) delete props[propId]; else props[propId] = value;
    await updatePage(rowId, { props });
  }
}

/** Configure la base liée d'une relation (et sa propriété miroir si bidirectionnelle). */
export async function setRelationTarget(dbId: ID, propId: string, targetId: ID | null, twoWay: boolean, mirrorName?: string) {
  const s = cachedSchema(dbId) ?? await loadSchema(dbId);
  const prop = s?.properties.find(p => p.id === propId);
  if (!s || !prop) return;
  const prevTarget = prop.relation?.databaseId;
  const prevMirror = prop.relation?.syncedPropId;
  if (prevTarget && prevTarget !== targetId) await clearValues(dbId, propId);
  if (prevMirror && prevTarget && (prevTarget !== targetId || !twoWay)) {
    await mutateSchema(prevTarget, t => { t.properties = t.properties.filter(p => p.id !== prevMirror); cleanViewsFor(t, prevMirror); }).catch(() => undefined);
    if (prevTarget) await clearValues(prevTarget, prevMirror);
  }
  await mutateSchema(dbId, x => {
    const p = x.properties.find(q => q.id === propId); if (!p) return;
    p.relation = targetId ? { databaseId: targetId, ...(twoWay && prevTarget === targetId && prevMirror ? { syncedPropId: prevMirror } : {}) } : undefined;
  });
  if (!targetId || !twoWay || (prevTarget === targetId && prevMirror)) return;
  // Création de la propriété miroir dans la base cible.
  const dbTitle = getPage(dbId)?.title?.trim() || 'Relation';
  const mirrorId = newId();
  await mutateSchema(targetId, t => {
    t.properties.push({ id: mirrorId, name: uniqueName(mirrorName?.trim() || dbTitle, t.properties.map(p => p.name)), type: 'relation', relation: { databaseId: dbId, syncedPropId: propId } });
    for (const v of t.views) if (v.type !== 'table') v.hiddenProps = [...(v.hiddenProps ?? []), mirrorId];
  });
  await mutateSchema(dbId, x => { const p = x.properties.find(q => q.id === propId); if (p?.relation) p.relation.syncedPropId = mirrorId; });
  // Remplit le miroir avec les liens existants.
  for (const r of liveRows(dbId)) {
    for (const tid of asList(r.props?.[propId])) {
      const t = getPage(tid); if (!t || t.parentId !== targetId) continue;
      await updatePage(tid, { props: { ...t.props, [mirrorId]: mirrorValue(t.props?.[mirrorId], r.id, true) } });
    }
  }
}

// ── Options (sélections) ─────────────────────────────────────
export async function addOption(dbId: ID, propId: string, name: string, color?: string): Promise<SelectOption | undefined> {
  const clean = name.trim(); if (!clean) return;
  let out: SelectOption | undefined;
  await mutateSchema(dbId, s => {
    const p = s.properties.find(x => x.id === propId); if (!p) return;
    p.options ??= [];
    out = p.options.find(o => o.name.toLowerCase() === clean.toLowerCase());
    if (!out) { out = { id: newId(), name: clean, color: color ?? nextColor(p.options.map(o => o.color)) }; p.options.push(out); }
  });
  return out;
}

export async function updateOption(dbId: ID, propId: string, optionId: string, patch: { name?: string; color?: ColorName | string }) {
  const s = cachedSchema(dbId) ?? await loadSchema(dbId);
  const prop = s?.properties.find(p => p.id === propId);
  const opt = prop?.options?.find(o => o.id === optionId);
  if (!prop || !opt) return;
  const oldName = opt.name;
  const newName = patch.name?.trim();
  if (newName !== undefined) {
    if (!newName) throw new Error('Le nom de l’option ne peut pas être vide');
    if (prop.options!.some(o => o.id !== optionId && o.name.toLowerCase() === newName.toLowerCase())) throw new Error(`L’option « ${newName} » existe déjà`);
  }
  await mutateSchema(dbId, x => {
    const p = x.properties.find(q => q.id === propId); const o = p?.options?.find(q => q.id === optionId); if (!o) return;
    if (patch.color) o.color = (COLORS as readonly string[]).includes(patch.color) ? patch.color : 'default';
    if (newName && newName !== oldName) {
      o.name = newName;
      for (const v of x.views) for (const f of v.filters) if (f.propId === propId && (f.value === oldName || f.value === optionId)) f.value = newName;
      for (const v of x.views) if (v.hiddenGroups) v.hiddenGroups = v.hiddenGroups.map(g => (g === oldName ? newName : g));
    }
  });
  if (newName && newName !== oldName) {
    for (const r of liveRows(dbId)) {
      const v = r.props?.[propId];
      if (prop.type === 'multi_select') {
        const list = asList(v);
        if (list.some(x => x === oldName || x === optionId)) await updatePage(r.id, { props: { ...r.props, [propId]: list.map(x => (x === oldName || x === optionId ? newName : x)) } });
      } else if (v === oldName || v === optionId) await updatePage(r.id, { props: { ...r.props, [propId]: newName } });
    }
  }
}

export async function deleteOption(dbId: ID, propId: string, optionId: string) {
  const s = cachedSchema(dbId) ?? await loadSchema(dbId);
  const prop = s?.properties.find(p => p.id === propId);
  const opt = prop?.options?.find(o => o.id === optionId);
  if (!prop || !opt) return;
  await mutateSchema(dbId, x => {
    const p = x.properties.find(q => q.id === propId); if (!p?.options) return;
    p.options = p.options.filter(o => o.id !== optionId);
    for (const v of x.views) v.filters = v.filters.filter(f => !(f.propId === propId && (f.value === opt.name || f.value === optionId)));
  });
  for (const r of liveRows(dbId)) {
    const v = r.props?.[propId];
    if (prop.type === 'multi_select') {
      const list = asList(v);
      if (list.some(x => x === opt.name || x === optionId)) await updatePage(r.id, { props: { ...r.props, [propId]: list.filter(x => x !== opt.name && x !== optionId) } });
    } else if (v === opt.name || v === optionId) {
      const props = { ...r.props }; delete props[propId]; await updatePage(r.id, { props });
    }
  }
}

export const reorderOptions = (dbId: ID, propId: string, ids: string[]) => mutateSchema(dbId, s => {
  const p = s.properties.find(x => x.id === propId); if (!p?.options) return;
  p.options = [...ids.map(id => p.options!.find(o => o.id === id)).filter((o): o is SelectOption => !!o), ...p.options.filter(o => !ids.includes(o.id))];
});

// ── Lignes ───────────────────────────────────────────────────
const isEmptyStored = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export async function createRow(dbId: ID, init: { title?: string; props?: Record<string, unknown>; order?: number; icon?: string; content?: unknown } = {}): Promise<Page> {
  const { title: t, ...rest } = init.props ?? {};
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (!isEmptyStored(v)) props[k] = v;
  const page = await createPage({
    parentId: dbId, kind: 'page', title: init.title ?? (typeof t === 'string' ? t : ''), props,
    ...(init.order !== undefined ? { order: init.order } : {}), ...(init.icon ? { icon: init.icon } : {}),
    ...(init.content ? { content: init.content } : {}),
  });
  // Relations bidirectionnelles pré-remplies (ex. filtre « contient »).
  const s = cachedSchema(dbId);
  for (const p of s?.properties ?? []) if (p.type === 'relation' && props[p.id]) await syncMirror(page.id, p, [], props[p.id]);
  return page;
}

async function syncMirror(rowId: ID, prop: PropDef, before: unknown, after: unknown) {
  const conf = prop.relation;
  if (!conf?.syncedPropId || !conf.databaseId) return;
  const { added, removed } = relationDiff(before, after);
  for (const [ids, link] of [[added, true], [removed, false]] as const) {
    for (const id of ids) {
      const t = getPage(id);
      if (!t || t.parentId !== conf.databaseId) continue;
      const next = mirrorValue(t.props?.[conf.syncedPropId], rowId, link);
      if (JSON.stringify(next) !== JSON.stringify(asList(t.props?.[conf.syncedPropId]))) {
        await updatePage(id, { props: { ...t.props, [conf.syncedPropId]: next } });
      }
    }
  }
}

/** Écrit une valeur de cellule (titre, valeur stockée, synchro des relations). */
export async function setValue(rowOrId: Page | ID, prop: PropDef, value: unknown) {
  const id = typeof rowOrId === 'string' ? rowOrId : rowOrId.id;
  const row = getPage(id); if (!row) return;
  if (prop.type === 'title') { if (asText(value) !== row.title) await updatePage(id, { title: asText(value) }); return; }
  if (isComputed(prop.type)) return;
  const before = row.props?.[prop.id];
  if (JSON.stringify(before) === JSON.stringify(value)) return;
  const props = { ...(row.props ?? {}) };
  if (isEmptyStored(value)) delete props[prop.id]; else props[prop.id] = value;
  await updatePage(id, { props });
  if (prop.type === 'relation') await syncMirror(id, prop, before, value);
}

/** Écrit plusieurs valeurs d'un coup (clé = id de propriété, 'title' pour le titre). */
export async function setValues(rowId: ID, values: Record<string, unknown>, schema?: Schema) {
  const row = getPage(rowId); if (!row?.parentId) return;
  const s = schema ?? cachedSchema(row.parentId) ?? await loadSchema(row.parentId);
  for (const [k, v] of Object.entries(values)) {
    const p = s?.properties.find(x => x.id === k);
    if (p) await setValue(rowId, p, v);
    else if (k === 'title') await updatePage(rowId, { title: asText(v) });
  }
}

/** Ordre entre deux voisins (null = plus de place). */
export function orderBetween(prev?: number, next?: number): number | null {
  if (prev === undefined && next === undefined) return Date.now();
  if (prev === undefined) return next! - 1024;
  if (next === undefined) return prev + 1024;
  const mid = (prev + next) / 2;
  return mid > prev && mid < next ? mid : null;
}

/** Place `rowId` à l'index donné dans `ordered` (liste visible sans la ligne déplacée). */
export async function placeRow(rowId: ID, ordered: Page[], index: number, extra: Record<string, unknown> = {}) {
  const list = ordered.filter(r => r.id !== rowId);
  const i = Math.max(0, Math.min(index, list.length));
  const o = orderBetween(list[i - 1]?.order, list[i]?.order);
  const row = getPage(rowId); if (!row) return;
  const props = Object.keys(extra).length ? { props: { ...row.props, ...extra } } : {};
  if (o !== null) { await updatePage(rowId, { order: o, ...props }); return; }
  // Renumérotation (cas extrême d'insertions répétées au même endroit).
  const seq = [...list.slice(0, i), row, ...list.slice(i)];
  const base = seq[0]?.order ?? Date.now();
  for (let k = 0; k < seq.length; k++) {
    const r = seq[k];
    const order = base + k * 1024;
    if (r.id === rowId) await updatePage(rowId, { order, ...props });
    else if (r.order !== order) await updatePage(r.id, { order });
  }
}

export async function trashRows(ids: ID[]) {
  if (!ids.length) return;
  for (const id of ids) await trashPage(id);
  const n = ids.length;
  toastAction(n > 1 ? `${n} lignes déplacées dans la corbeille` : 'Ligne déplacée dans la corbeille', 'Annuler', () => {
    void Promise.all(ids.map(id => restorePage(id))).then(() => toast(n > 1 ? 'Lignes restaurées' : 'Ligne restaurée', 'success'));
  });
}

export async function duplicateRows(ids: ID[]): Promise<Page[]> {
  const out: Page[] = [];
  for (const id of ids) {
    const r = getPage(id); if (!r?.parentId) continue;
    const siblings = liveRows(r.parentId);
    const i = siblings.findIndex(x => x.id === id);
    const order = orderBetween(r.order, siblings[i + 1]?.order) ?? r.order + 1e-6;
    const copy = await createPage({
      parentId: r.parentId, kind: r.kind, title: r.title, icon: r.icon, cover: r.cover,
      content: structuredClone(r.content), props: structuredClone(r.props ?? {}), order,
    });
    const s = cachedSchema(r.parentId);
    for (const p of s?.properties ?? []) if (p.type === 'relation' && copy.props?.[p.id]) await syncMirror(copy.id, p, [], copy.props[p.id]);
    out.push(copy);
  }
  return out;
}

/** Initialise un schéma par défaut pour une page « database » qui n'en a pas. */
export async function ensureSchemaFor(dbId: ID): Promise<Schema> {
  const s = await loadSchema(dbId);
  if (s) return s;
  const schema = normalizeSchema({
    id: dbId,
    properties: [
      { id: 'title', name: 'Nom', type: 'title' },
      { id: newId(), name: 'Statut', type: 'status', options: DEFAULT_STATUS.map(o => ({ ...o, id: newId() })) },
      { id: newId(), name: 'Étiquettes', type: 'multi_select', options: [] },
      { id: newId(), name: 'Date', type: 'date' },
    ],
    views: [{ id: newId(), name: 'Tableau', type: 'table', filters: [], sorts: [] }],
  }, dbId);
  await putSchema(schema);
  return schema;
}
