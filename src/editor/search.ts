// Recherche globale (Ctrl+K) : pages (titre + contenu), blocs (aller au bloc). FTS5 en Tauri, mémoire sinon.
import { allPages, ancestorsOf, displayTitle, isInTrash } from '../db/pages';
import { searchFts } from '../db/store';
import type { Page } from '../db/types';
import { blockTexts } from './text';
import { containsAllWords, fuzzyBest, normalize, queryWords, snippetAround } from './fuzzy';

export interface PageHit { pageId: string; title: string; icon?: string; path: string; snippet?: string; score: number }
export interface BlockHit { pageId: string; pageTitle: string; icon?: string; index: number; text: string; snippet: string; score: number }
export interface SearchResults { pages: PageHit[]; blocks: BlockHit[] }

interface TextIndex { text: string; norm: string; blocks: string[]; normBlocks: string[] }
const cache = new WeakMap<object, TextIndex>();
const EMPTY: TextIndex = { text: '', norm: '', blocks: [], normBlocks: [] };

/** Texte indexé d'une page (mis en cache tant que son contenu ne change pas). */
export function pageIndex(page: Pick<Page, 'content'>): TextIndex {
  const c = page.content;
  if (!c || typeof c !== 'object') return EMPTY;
  let v = cache.get(c as object);
  if (!v) {
    const blocks = blockTexts(c);
    const text = blocks.join('\n');
    v = { text, norm: normalize(text), blocks, normBlocks: blocks.map(normalize) };
    cache.set(c as object, v);
  }
  return v;
}

const pathOf = (p: Page, map: Record<string, Page>) => ancestorsOf(p.id, map).map(a => displayTitle(a)).join(' / ');

/** Recherche en mémoire (fonction pure sur la liste fournie). `rank` = rangs FTS5 (0 = meilleur). */
export function searchPages(pages: Page[], query: string, opts: { pageLimit?: number; blockLimit?: number; rank?: Map<string, number>; now?: number } = {}): SearchResults {
  const words = queryWords(query);
  if (!words.length) return { pages: [], blocks: [] };
  const map: Record<string, Page> = Object.fromEntries(pages.map(p => [p.id, p]));
  const now = opts.now ?? Date.now();
  const pageHits: PageHit[] = []; const blockHits: BlockHit[] = [];
  for (const p of pages) {
    if (isInTrash(p.id, map)) continue;
    const title = displayTitle(p);
    const titleScore = p.title.trim() ? fuzzyBest(query, [[title, 1]]) : null;
    const idx = pageIndex(p);
    const inBody = containsAllWords(idx.norm, words);
    const fts = opts.rank?.get(p.id);
    if (titleScore === null && !inBody && fts === undefined) continue;
    const ageDays = (now - p.updatedAt) / 86_400_000;
    const score = (titleScore ?? 0) * 1.6 + (inBody ? 220 : 0) + (fts !== undefined ? Math.max(0, 260 - fts * 8) : 0) + Math.max(0, 30 - ageDays);
    pageHits.push({ pageId: p.id, title, icon: p.icon, path: pathOf(p, map), snippet: inBody ? snippetAround(idx.text, words) : undefined, score });
    if (inBody) {
      let n = 0;
      for (let i = 0; i < idx.blocks.length && n < 3; i++) {
        if (!containsAllWords(idx.normBlocks[i], words)) continue;
        blockHits.push({ pageId: p.id, pageTitle: title, icon: p.icon, index: i, text: idx.blocks[i], snippet: snippetAround(idx.blocks[i], words, 60), score: score - i * 0.001 });
        n++;
      }
    }
  }
  pageHits.sort((a, b) => b.score - a.score);
  blockHits.sort((a, b) => b.score - a.score);
  return { pages: pageHits.slice(0, opts.pageLimit ?? 20), blocks: blockHits.slice(0, opts.blockLimit ?? 20) };
}

/** Recherche globale : rangs FTS5 (Tauri) fusionnés avec la recherche mémoire (titres flous, extraits). */
export async function searchAll(query: string): Promise<SearchResults> {
  const fts = await searchFts(query, 80);
  const rank = fts ? new Map(fts.map((h, i) => [h.pageId, i])) : undefined;
  return searchPages(allPages(), query, { rank });
}

// ── Pages récentes (palette vide) ──
const RECENT_KEY = 'prisme:ui:recent';
export function recentPageIds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}
export function pushRecentPage(id: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentPageIds().filter(x => x !== id)].slice(0, 12))); } catch { /* stockage indisponible */ }
}
export const recentPages = (): Page[] => {
  const pages = allPages(); const map = Object.fromEntries(pages.map(p => [p.id, p]));
  return recentPageIds().map(id => map[id]).filter((p): p is Page => !!p && !isInTrash(p.id, map));
};
