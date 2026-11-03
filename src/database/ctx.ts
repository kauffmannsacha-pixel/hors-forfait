// Contexte moteur (schéma + bases liées + personnes + pages), en asynchrone (API/outils) ou réactif (React).
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getPage, usePages } from '../db/pages';
import type { ID, Page } from '../db/types';
import { makeCtx, type EngineCtx } from './engine';
import type { Schema } from './model';
import { loadPeople, usePeople } from './people';
import { cachedSchema, loadSchema, preloadSchemas, useSchemas } from './schemaStore';

/** Lignes vivantes d'une base, dans l'ordre manuel. */
export function liveRows(dbId: ID, pages: Record<ID, Page> = usePages.getState().pages): Page[] {
  const out: Page[] = [];
  for (const p of Object.values(pages)) if (p.parentId === dbId && !p.trashed) out.push(p);
  return out.sort((a, b) => a.order - b.order);
}

/** Bases liées (relations), sur deux niveaux (rollups de rollups). */
export function relatedIds(schema: Schema, get: (id: ID) => Schema | undefined = cachedSchema): ID[] {
  const out = new Set<ID>();
  for (const p of schema.properties) if (p.type === 'relation' && p.relation?.databaseId) out.add(p.relation.databaseId);
  for (const id of [...out]) {
    const s = get(id);
    for (const p of s?.properties ?? []) if (p.type === 'relation' && p.relation?.databaseId) out.add(p.relation.databaseId);
  }
  out.delete(schema.id);
  return [...out];
}

/** Contexte complet pour une base (chargement des dépendances). */
export async function engineFor(dbId: ID): Promise<EngineCtx | undefined> {
  const schema = await loadSchema(dbId);
  if (!schema) return undefined;
  await preloadSchemas(relatedIds(schema));
  await preloadSchemas(relatedIds(schema));
  const people = await loadPeople();
  return makeCtx(schema, { getSchema: id => cachedSchema(id), getPage, people });
}

/** Contexte réactif : se recalcule quand les lignes de la base (ou des bases liées) changent. */
export function useEngine(schema: Schema | null | undefined): { ctx: EngineCtx | null; rows: Page[] } {
  const schemas = useSchemas(s => s.schemas);
  const people = usePeople();
  const related = useMemo(() => (schema ? relatedIds(schema, id => schemas[id]) : []), [schema, schemas]);
  useEffect(() => { if (related.length) void preloadSchemas(related); }, [related]);
  const dbId = schema?.id;
  // Abonnement fin : seulement les lignes de cette base et des bases liées.
  const watched = usePages(useShallow(s => {
    if (!dbId) return [] as Page[];
    const ids = new Set([dbId, ...related]);
    const out: Page[] = [];
    for (const p of Object.values(s.pages)) if (p.parentId && ids.has(p.parentId)) out.push(p);
    return out;
  }));
  return useMemo(() => {
    if (!schema) return { ctx: null, rows: [] };
    const ctx = makeCtx(schema, { getSchema: id => schemas[id] ?? cachedSchema(id), getPage: id => usePages.getState().pages[id], people });
    const rows = watched.filter(p => p.parentId === schema.id && !p.trashed).sort((a, b) => a.order - b.order);
    return { ctx, rows };
  }, [schema, schemas, people, watched]);
}
