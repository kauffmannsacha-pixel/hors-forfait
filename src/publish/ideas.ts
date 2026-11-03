// Lien avec le kanban « Idées vidéo » (Idée → Script → Tournage → Montage → Publié).
import { ensureDatabase, ensureFromTemplate, getSchema, listDatabases, readDate, rowsOf, saveSchema, updateRow } from '../database/api';
import { allPages, loadPages, usePages } from '../db/pages';
import type { DatabaseSchema, ID, Page, PropertyDef } from '../db/types';

export const IDEAS_DB_TITLE = 'Idées vidéo';
export const IDEAS_TEMPLATE = 'idees-video';
export const IDEA_STATUSES = ['Idée', 'Script', 'Tournage', 'Montage', 'Publié'] as const;
const STATUS_COLORS = ['gray', 'blue', 'orange', 'purple', 'green'];
export const P = { status: 'Statut', date: 'Date de publication', channel: 'Chaîne', url: 'Lien vidéo', videoId: 'ID vidéo' } as const;

const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

/** Attend le chargement des pages (sinon on créerait une base en double). */
export async function pagesReady(): Promise<void> {
  if (usePages.getState().loaded) return;
  await new Promise<void>(resolve => {
    const unsub = usePages.subscribe(s => { if (s.loaded) { clearTimeout(t); unsub(); resolve(); } });
    const t = setTimeout(() => { unsub(); resolve(); }, 4000);
  });
  if (!usePages.getState().loaded) await loadPages();
}

export function findIdeasDb(): Page | undefined {
  const dbs = listDatabases();
  return dbs.find(p => p.meta?.template === IDEAS_TEMPLATE) ?? dbs.find(p => p.title.trim().toLowerCase() === IDEAS_DB_TITLE.toLowerCase());
}

const FALLBACK_PROPS: Omit<PropertyDef, 'id'>[] = [
  { name: 'Titre', type: 'title' },
  { name: P.status, type: 'status', options: IDEA_STATUSES.map((name, i) => ({ id: '', name, color: STATUS_COLORS[i] })) },
  { name: P.date, type: 'date' },
  { name: P.channel, type: 'select', options: [] },
  { name: P.url, type: 'url' },
  { name: P.videoId, type: 'text' },
];

let ensuring: Promise<ID> | null = null;
/** Base « Idées vidéo » (modèle du module Bases, sinon ensureDatabase), complétée des propriétés utiles à la publication. */
export function ensureIdeasDb(): Promise<ID> {
  ensuring ??= (async () => {
    await pagesReady();
    let id = findIdeasDb()?.id;
    if (!id) {
      try { id = await ensureFromTemplate(IDEAS_TEMPLATE); }
      catch { id = await ensureDatabase(IDEAS_DB_TITLE, { icon: '🎬', properties: FALLBACK_PROPS }); }
    }
    await completeSchema(id);
    return id;
  })().catch(e => { ensuring = null; throw e; });
  return ensuring;
}

const findP = (s: DatabaseSchema | undefined, name: string) => s?.properties.find(p => p.name.trim().toLowerCase() === name.toLowerCase());

async function completeSchema(id: ID) {
  const s = await getSchema(id);
  if (!s) return;
  let changed = false;
  for (const need of FALLBACK_PROPS.filter(p => p.type !== 'title')) {
    const ex = findP(s, need.name);
    if (!ex) { s.properties.push({ ...need, id: shortId(), ...(need.options ? { options: need.options.map(o => ({ ...o, id: shortId() })) } : {}) }); changed = true; }
    else if (need.name === P.status && (ex.type === 'status' || ex.type === 'select')) {
      IDEA_STATUSES.forEach((name, i) => { if (!(ex.options ?? []).some(o => o.name === name)) { (ex.options ??= []).push({ id: shortId(), name, color: STATUS_COLORS[i] }); changed = true; } });
    }
  }
  const status = findP(s, P.status), date = findP(s, P.date);
  if (status && !s.views.some(v => v.type === 'board')) { s.views.unshift({ id: shortId(), name: 'Pipeline', type: 'board', filters: [], sorts: [], groupBy: status.id }); changed = true; }
  for (const v of s.views) if (v.type === 'board' && !v.groupBy && status) { v.groupBy = status.id; changed = true; }
  if (date && !s.views.some(v => v.type === 'calendar')) { s.views.push({ id: shortId(), name: 'Calendrier de publication', type: 'calendar', filters: [], sorts: [], dateProp: date.id }); changed = true; }
  if (changed) await saveSchema(s);
}

export interface Idea { id: ID; title: string; icon?: string; status: string; date: Date | null; hasTime: boolean; channel: string; url: string; videoId: string; updatedAt: number }

export function readIdea(row: Page, s?: DatabaseSchema): Idea {
  const val = (name: string) => { const p = findP(s, name); return p ? row.props?.[p.id] : undefined; };
  const opt = (name: string) => { const p = findP(s, name); const v = val(name); return p?.options?.find(o => o.name === v || o.id === v)?.name ?? (typeof v === 'string' ? v : ''); };
  const d = readDate(val(P.date));
  return {
    id: row.id, title: row.title, icon: row.icon, status: opt(P.status), date: d?.start ?? null, hasTime: !!d?.hasTime,
    channel: opt(P.channel), url: typeof val(P.url) === 'string' ? String(val(P.url)) : '', videoId: typeof val(P.videoId) === 'string' ? String(val(P.videoId)) : '', updatedAt: row.updatedAt,
  };
}

export async function listIdeas(): Promise<{ dbId: ID; ideas: Idea[] }> {
  const dbId = await ensureIdeasDb();
  const s = await getSchema(dbId);
  return { dbId, ideas: rowsOf(dbId).map(r => readIdea(r, s)) };
}

/** Après publication : la carte passe à « Publié » avec le lien, l'id vidéo, la date et la chaîne. */
export async function markIdeaPublished(rowId: ID, info: { url: string; videoId: string; date: Date; channelTitle: string }): Promise<void> {
  await ensureIdeasDb();
  await updateRow(rowId, { [P.status]: 'Publié', [P.date]: info.date, [P.url]: info.url, [P.videoId]: info.videoId, ...(info.channelTitle ? { [P.channel]: info.channelTitle } : {}) });
}

/** Page Script liée à une carte : sous-page de la carte, sinon page Script du même titre. */
export function scriptForIdea(idea: Pick<Idea, 'id' | 'title'>): Page | undefined {
  const scripts = allPages().filter(p => p.kind === 'script' && !p.trashed);
  const t = idea.title.trim().toLowerCase();
  return scripts.find(p => p.parentId === idea.id) ?? scripts.find(p => p.title.trim().toLowerCase() === t) ?? scripts.find(p => p.meta?.ideaId === idea.id);
}
export const scriptPages = () => allPages().filter(p => p.kind === 'script' && !p.trashed).sort((a, b) => b.updatedAt - a.updatedAt);
