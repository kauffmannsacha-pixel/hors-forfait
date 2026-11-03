// API pages (réactive via zustand). Le module éditeur peut l'enrichir sans casser ces signatures.
import { create } from 'zustand';
import { repo, uid } from './store';
import type { ID, Page, PageKind } from './types';

interface PagesState { pages: Record<ID, Page>; loaded: boolean }
export const usePages = create<PagesState>(() => ({ pages: {}, loaded: false }));

export async function loadPages() {
  const all = await repo.listPages();
  usePages.setState({ pages: Object.fromEntries(all.map(p => [p.id, p])), loaded: true });
}
export const getPage = (id: ID): Page | undefined => usePages.getState().pages[id];
export const allPages = (): Page[] => Object.values(usePages.getState().pages);
export const childrenOf = (parentId: ID | null) =>
  allPages().filter(p => p.parentId === parentId && !p.trashed).sort((a, b) => a.order - b.order);

export async function createPage(init: Partial<Page> & { title?: string; kind?: PageKind } = {}): Promise<Page> {
  const now = Date.now();
  const p: Page = {
    id: uid(), parentId: null, title: '', content: { type: 'doc', content: [{ type: 'paragraph' }] },
    favorite: false, trashed: false, kind: 'page', createdAt: now, updatedAt: now, order: now, ...init,
  };
  usePages.setState(s => ({ pages: { ...s.pages, [p.id]: p } }));
  await repo.savePage(p);
  return p;
}

const versionTimers = new Map<ID, number>();
export async function updatePage(id: ID, patch: Partial<Page>): Promise<Page | undefined> {
  const cur = getPage(id); if (!cur) return;
  const next: Page = { ...cur, ...patch, updatedAt: Date.now() };
  usePages.setState(s => ({ pages: { ...s.pages, [id]: next } }));
  await repo.savePage(next);
  // Historique : un instantané max toutes les 2 min d'édition
  const last = versionTimers.get(id) ?? 0;
  if ((patch.content !== undefined || patch.title !== undefined) && Date.now() - last > 120_000) {
    versionTimers.set(id, Date.now());
    await repo.addVersion({ id: uid(), pageId: id, content: next.content, title: next.title, at: Date.now() });
  }
  return next;
}
export const trashPage = (id: ID) => updatePage(id, { trashed: true });
export const restorePage = (id: ID) => updatePage(id, { trashed: false });
export async function deletePageForever(id: ID) {
  for (const c of allPages().filter(p => p.parentId === id)) await deletePageForever(c.id);
  usePages.setState(s => { const pages = { ...s.pages }; delete pages[id]; return { pages }; });
  await repo.deletePage(id);
}

// ─────────────────────────────────────────────────────────────
// Ajouts module éditeur : arbre de pages, déplacement, corbeille, duplication.
// Fonctions pures (paramètre `pages` optionnel) pour être testables.
// ─────────────────────────────────────────────────────────────
type PageMap = Record<ID, Page>;
const currentPages = (): PageMap => usePages.getState().pages;

/** Titre affichable (« Sans titre » si vide). */
export const displayTitle = (p: Pick<Page, 'title'> | undefined | null) => (p?.title?.trim() ? p.title : 'Sans titre');

/** Ancêtres d'une page, de la racine vers le parent direct. */
export function ancestorsOf(id: ID, pages: PageMap = currentPages()): Page[] {
  const out: Page[] = []; const seen = new Set<ID>([id]);
  let pid = pages[id]?.parentId ?? null;
  while (pid && pages[pid] && !seen.has(pid)) { seen.add(pid); out.unshift(pages[pid]); pid = pages[pid].parentId; }
  return out;
}

/** true si `id` vaut `ancestorId` ou se trouve dans sa descendance. */
export function isDescendantOf(id: ID, ancestorId: ID, pages: PageMap = currentPages()): boolean {
  let cur: ID | null = id; const seen = new Set<ID>();
  while (cur && !seen.has(cur)) { if (cur === ancestorId) return true; seen.add(cur); cur = pages[cur]?.parentId ?? null; }
  return false;
}

/** Tous les descendants d'une page (sous-pages et lignes de bases), en profondeur. */
export function descendantsOf(id: ID, pages: PageMap = currentPages()): Page[] {
  const byParent = new Map<ID, Page[]>();
  for (const p of Object.values(pages)) if (p.parentId) { const a = byParent.get(p.parentId); if (a) a.push(p); else byParent.set(p.parentId, [p]); }
  const out: Page[] = []; const stack: ID[] = [id]; const seen = new Set<ID>([id]);
  while (stack.length) {
    const x = stack.pop() as ID;
    for (const c of (byParent.get(x) ?? []).sort((a, b) => a.order - b.order)) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); stack.push(c.id); }
  }
  return out;
}

/** La page est-elle dans la corbeille (elle-même ou l'un de ses ancêtres) ? */
export function isInTrash(id: ID, pages: PageMap = currentPages()): boolean {
  let cur: ID | null = id; const seen = new Set<ID>();
  while (cur && pages[cur] && !seen.has(cur)) { if (pages[cur].trashed) return true; seen.add(cur); cur = pages[cur].parentId; }
  return false;
}

/** Racines de la corbeille : pages supprimées dont aucun ancêtre n'est supprimé (les plus récentes d'abord). */
export function trashedRoots(pages: PageMap = currentPages()): Page[] {
  return Object.values(pages)
    .filter(p => p.trashed && !(p.parentId && isInTrash(p.parentId, pages)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Pages favorites visibles (hors corbeille), dans l'ordre d'ajout. */
export function favoritePages(pages: PageMap = currentPages()): Page[] {
  return Object.values(pages).filter(p => p.favorite && !isInTrash(p.id, pages)).sort((a, b) => a.order - b.order);
}

/** Frères visibles (non supprimés) sous `parentId`, triés par ordre. */
export function siblingsOf(parentId: ID | null, pages: PageMap = currentPages(), exclude?: ID): Page[] {
  return Object.values(pages).filter(p => p.parentId === parentId && !p.trashed && p.id !== exclude).sort((a, b) => a.order - b.order);
}

/** Valeur d'ordre pour insérer à `index` parmi `siblings` (triés). `null` = plus de place, il faut renuméroter. */
export function orderBetween(siblings: Pick<Page, 'order'>[], index: number, now = Date.now()): number | null {
  const prev = siblings[index - 1]; const next = siblings[index];
  if (!prev && !next) return now;
  if (!prev) return (next as Page).order - 1024;
  if (!next) return Math.max(prev.order + 1024, now);
  if (next.order - prev.order < 1e-6) return null;
  const mid = (prev.order + next.order) / 2;
  return mid > prev.order && mid < next.order ? mid : null;
}

/**
 * Calcule le déplacement d'une page (pur) : renvoie les pages modifiées.
 * Lève une erreur si on essaie de placer une page dans sa propre descendance.
 */
export function planMove(pages: PageMap, id: ID, parentId: ID | null, index: number, now = Date.now()): Page[] {
  const page = pages[id]; if (!page) return [];
  if (parentId && !pages[parentId]) parentId = null;
  if (parentId && isDescendantOf(parentId, id, pages)) throw new Error('Impossible de déplacer une page dans elle-même ou dans une de ses sous-pages.');
  const siblings = siblingsOf(parentId, pages, id);
  const i = Math.max(0, Math.min(index, siblings.length));
  const order = orderBetween(siblings, i, now);
  if (order !== null) return [{ ...page, parentId, order }];
  // Plus d'espace entre les voisins : renumérotation de la fratrie.
  const base = siblings[0]?.order ?? now;
  const seq = [...siblings.slice(0, i), page, ...siblings.slice(i)];
  const out: Page[] = [];
  seq.forEach((p, k) => {
    const o = base + k * 1024;
    if (p.id === id) out.push({ ...page, parentId, order: o });
    else if (p.order !== o) out.push({ ...p, order: o });
  });
  return out;
}

async function commitPages(changed: Page[]) {
  if (!changed.length) return;
  usePages.setState(s => { const m = { ...s.pages }; for (const p of changed) m[p.id] = p; return { pages: m }; });
  for (const p of changed) await repo.savePage(p);
}

/** Déplace une page sous `parentId` (null = racine) à la position `index` parmi ses frères. */
export async function movePage(id: ID, parentId: ID | null, index: number): Promise<Page | undefined> {
  const changed = planMove(currentPages(), id, parentId, index);
  await commitPages(changed);
  return changed.find(p => p.id === id);
}

/** Restaure une page de la corbeille ; si son parent n'existe plus ou est supprimé, elle revient à la racine. */
export async function restoreFromTrash(id: ID) {
  const pages = currentPages(); const p = pages[id]; if (!p) return;
  const parentGone = !!p.parentId && (!pages[p.parentId] || isInTrash(p.parentId, pages));
  return updatePage(id, { trashed: false, ...(parentGone ? { parentId: null } : {}) });
}

/** Supprime définitivement toutes les pages de la corbeille (et leurs sous-pages). */
export async function emptyTrash() { for (const p of trashedRoots()) await deletePageForever(p.id); }

/** Ajoute / retire des favoris. */
export const setFavorite = (id: ID, favorite: boolean) => updatePage(id, { favorite });

/** Duplique une page (et, par défaut, toute sa descendance). Le schéma des bases dupliquées est copié. */
export async function duplicatePage(id: ID, opts: { parentId?: ID | null; titleSuffix?: string; deep?: boolean } = {}): Promise<Page | undefined> {
  const pages = currentPages(); const src = pages[id]; if (!src) return;
  const now = Date.now();
  const parentId = opts.parentId !== undefined ? opts.parentId : src.parentId;
  const siblings = siblingsOf(parentId, pages);
  const at = siblings.findIndex(p => p.id === src.id);
  const order = orderBetween(siblings, at >= 0 ? at + 1 : siblings.length, now) ?? src.order + 1e-3;
  const copy = (p: Page, pid: ID | null, title: string, ord: number): Page =>
    ({ ...(JSON.parse(JSON.stringify(p)) as Page), id: uid(), parentId: pid, title, order: ord, createdAt: now, updatedAt: now, favorite: false, trashed: false });
  const root = copy(src, parentId, src.title + (opts.titleSuffix ?? ' (copie)'), order);
  const created: Page[] = [root]; const origOf = new Map<ID, ID>([[root.id, src.id]]);
  if (opts.deep ?? true) {
    const queue: [ID, ID][] = [[src.id, root.id]];
    while (queue.length) {
      const [from, to] = queue.shift() as [ID, ID];
      for (const c of Object.values(pages).filter(p => p.parentId === from && !p.trashed).sort((a, b) => a.order - b.order)) {
        const cc = copy(c, to, c.title, c.order); created.push(cc); origOf.set(cc.id, c.id); queue.push([c.id, cc.id]);
      }
    }
  }
  for (const p of created) if (p.kind === 'database') {
    const schema = await repo.kvGet<Record<string, unknown>>('db:' + origOf.get(p.id));
    if (schema) await repo.kvSet('db:' + p.id, { ...schema, id: p.id });
  }
  await commitPages(created);
  return root;
}
