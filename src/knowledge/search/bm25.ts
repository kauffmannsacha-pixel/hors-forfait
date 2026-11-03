// BM25 « maison » (pur, testé) — utilisé hors Tauri (pas de FTS5) et en repli si FTS5 échoue.
import { expandQuery, tokenize } from '../text';

export interface Bm25Field { text: string; weight: number }
interface Doc { len: number; tf: Map<string, number> }

export class Bm25Index {
  private docs = new Map<string, Doc>();
  private df = new Map<string, number>();
  private totalLen = 0;
  private vocab: string[] | null = null;
  constructor(private k1 = 1.2, private b = 0.75) {}

  get size() { return this.docs.size; }

  /** Ajoute (ou remplace) un document ; les champs pondérés comptent `weight` fois (titre ×2…). */
  add(id: string, fields: Bm25Field[]) {
    if (this.docs.has(id)) this.remove(id);
    const tf = new Map<string, number>(); let len = 0;
    for (const f of fields) for (const t of tokenize(f.text)) { tf.set(t, (tf.get(t) ?? 0) + f.weight); len += f.weight; }
    this.docs.set(id, { len, tf });
    this.totalLen += len;
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.vocab = null;
  }

  remove(id: string) {
    const d = this.docs.get(id); if (!d) return;
    this.docs.delete(id); this.totalLen -= d.len;
    for (const t of d.tf.keys()) { const n = (this.df.get(t) ?? 1) - 1; n > 0 ? this.df.set(t, n) : this.df.delete(t); }
    this.vocab = null;
  }

  idf(term: string): number {
    const n = this.docs.size, df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Termes du vocabulaire correspondant à un terme de requête (exact + préfixe si ≥ 4 caractères). */
  private matches(term: string): string[] {
    if (term.length < 4) return this.df.has(term) ? [term] : [];
    if (!this.vocab) this.vocab = [...this.df.keys()];
    const out = this.vocab.filter(v => v === term || v.startsWith(term));
    return out.slice(0, 30);
  }

  /** Scores BM25 (> 0) des documents correspondant à la requête (synonymes FR/EN à mi-poids). */
  search(query: string, opts: { limit?: number; filter?: (id: string) => boolean } = {}): { id: string; score: number }[] {
    const terms = expandQuery(query);
    if (!terms.length || !this.docs.size) return [];
    const avgdl = this.totalLen / this.docs.size || 1;
    const scores = new Map<string, number>();
    for (const { term, weight } of terms) {
      const vs = this.matches(term);
      if (!vs.length) continue;
      const best = new Map<string, number>(); // meilleure variante par document
      for (const v of vs) {
        const idf = this.idf(v);
        for (const [id, d] of this.docs) {
          const tf = d.tf.get(v); if (!tf) continue;
          if (opts.filter && !opts.filter(id)) continue;
          const s = idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * d.len / avgdl));
          if (s > (best.get(id) ?? 0)) best.set(id, s);
        }
      }
      for (const [id, s] of best) scores.set(id, (scores.get(id) ?? 0) + s * weight);
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 100);
  }
}

/** Expression MATCH FTS5 sûre : termes (et synonymes) en préfixe, reliés par OR. */
export function ftsMatchExpression(query: string): string {
  return expandQuery(query)
    .slice(0, 24)
    .map(({ term }) => `"${term.replace(/"/g, '""')}"${term.length >= 3 ? '*' : ''}`)
    .join(' OR ');
}
