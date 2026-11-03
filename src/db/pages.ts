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
