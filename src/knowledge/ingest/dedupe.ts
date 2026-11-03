// Dédoublonnage (pur, testé) : empreinte exacte, similarité lexicale (Jaccard), similarité sémantique (cosinus).
import { jaccard, principleHash, tokenSet } from '../text';
import { dot } from '../search/vector';

export interface DedupeItem { title: string; text: string; vec?: Float32Array }
export interface DedupeOptions { lexical?: number; semantic?: number }

interface Entry { id: string; hash: string; tokens: Set<string>; vec?: Float32Array }

export class DedupeIndex {
  private entries: Entry[] = [];
  private byHash = new Map<string, string>();
  private lexical: number; private semantic: number;
  constructor(existing: (DedupeItem & { id: string })[] = [], opts: DedupeOptions = {}) {
    this.lexical = opts.lexical ?? 0.72;
    this.semantic = opts.semantic ?? 0.92;
    for (const e of existing) this.add(e.id, e);
  }
  add(id: string, item: DedupeItem) {
    const hash = principleHash(item.title, item.text);
    const e: Entry = { id, hash, tokens: tokenSet(item.title + ' ' + item.text), vec: item.vec };
    this.entries.push(e);
    if (!this.byHash.has(hash)) this.byHash.set(hash, id);
  }
  /** Id du doublon existant, ou null. */
  find(item: DedupeItem): string | null {
    const hash = principleHash(item.title, item.text);
    const exact = this.byHash.get(hash); if (exact) return exact;
    const toks = tokenSet(item.title + ' ' + item.text);
    for (const e of this.entries) {
      if (jaccard(toks, e.tokens) >= this.lexical) return e.id;
      if (item.vec && e.vec && item.vec.length === e.vec.length && dot(item.vec, e.vec) >= this.semantic) return e.id;
    }
    return null;
  }
}
