// Cache réactif des schémas (kv `db:<id>`) : lecture synchrone pour l'UI, écriture optimiste + persistance ordonnée.
import { useEffect } from 'react';
import { create } from 'zustand';
import { repo } from '../db/store';
import type { DatabaseSchema, ID } from '../db/types';
import { newId, type Schema } from './model';

interface SchemaState { schemas: Record<ID, Schema>; missing: Record<ID, true> }
export const useSchemas = create<SchemaState>(() => ({ schemas: {}, missing: {} }));

/** Rend un schéma exploitable même s'il a été écrit partiellement par un autre module. */
export function normalizeSchema(s: Partial<DatabaseSchema> | undefined, id: ID): Schema {
  const properties = Array.isArray(s?.properties) ? s!.properties.filter(p => p && p.id && p.type) : [];
  if (!properties.some(p => p.type === 'title')) properties.unshift({ id: 'title', name: 'Nom', type: 'title' });
  const views = (Array.isArray(s?.views) ? s!.views : []).filter(v => v && v.id).map(v => ({
    ...v, name: v.name || 'Vue', type: v.type || 'table', filters: Array.isArray(v.filters) ? v.filters : [], sorts: Array.isArray(v.sorts) ? v.sorts : [],
  }));
  if (!views.length) views.push({ id: newId(), name: 'Tableau', type: 'table', filters: [], sorts: [] });
  return { ...(s as object), id, properties, views } as Schema;
}

export const cachedSchema = (id: ID | null | undefined): Schema | undefined => (id ? useSchemas.getState().schemas[id] : undefined);

const inflight = new Map<ID, Promise<Schema | undefined>>();
export function loadSchema(id: ID): Promise<Schema | undefined> {
  const c = cachedSchema(id);
  if (c) return Promise.resolve(c);
  let p = inflight.get(id);
  if (!p) {
    p = repo.kvGet<DatabaseSchema>('db:' + id).then(raw => {
      inflight.delete(id);
      if (cachedSchema(id)) return cachedSchema(id);
      if (!raw) { useSchemas.setState(st => ({ missing: { ...st.missing, [id]: true } })); return undefined; }
      const s = normalizeSchema(raw, id);
      useSchemas.setState(st => ({ schemas: { ...st.schemas, [id]: s } }));
      return s;
    }, e => { inflight.delete(id); throw e; });
    inflight.set(id, p);
  }
  return p;
}

const queues = new Map<ID, Promise<void>>();
/** Met à jour le cache immédiatement puis persiste (écritures ordonnées, la dernière version gagne). */
export function putSchema(s: Schema): Promise<void> {
  const next = normalizeSchema(s, s.id);
  useSchemas.setState(st => {
    const missing = { ...st.missing }; delete missing[s.id];
    return { schemas: { ...st.schemas, [s.id]: next }, missing };
  });
  const run = (queues.get(s.id) ?? Promise.resolve()).catch(() => undefined)
    .then(() => repo.kvSet('db:' + s.id, cachedSchema(s.id) ?? next));
  queues.set(s.id, run);
  return run;
}

/** Charge plusieurs schémas (bases liées). */
export const preloadSchemas = (ids: (ID | undefined)[]) =>
  Promise.all([...new Set(ids.filter((x): x is ID => !!x))].map(id => loadSchema(id).catch(() => undefined)));

/** Schéma réactif : undefined = chargement, null = introuvable. */
export function useSchema(id: ID | null | undefined): Schema | null | undefined {
  const s = useSchemas(st => (id ? st.schemas[id] : undefined));
  const missing = useSchemas(st => (id ? !!st.missing[id] : false));
  useEffect(() => { if (id && !s && !missing) void loadSchema(id).catch(() => undefined); }, [id, s, missing]);
  if (!id) return null;
  return s ?? (missing ? null : undefined);
}
