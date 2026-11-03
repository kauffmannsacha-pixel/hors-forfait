// Stockage de la base de connaissances : SQLite (Tauri : kn_principles, kn_sources, kn_embeddings, kn_transcripts, FTS5 kn_fts),
// IndexedDB (navigateur), mémoire (tests / navigateur sans IndexedDB).
import type { Transcript } from '../api';
import type { KnPrinciple, KnSource } from '../types';

export interface KnStore {
  readonly engine: 'sqlite' | 'indexeddb' | 'memory';
  init(): Promise<void>;
  allPrinciples(): Promise<KnPrinciple[]>;
  putPrinciples(ps: KnPrinciple[]): Promise<void>;
  deletePrinciples(ids: string[]): Promise<void>;
  allSources(): Promise<KnSource[]>;
  putSource(s: KnSource): Promise<void>;
  deleteSource(id: string): Promise<void>;
  allEmbeddings(model: string): Promise<Map<string, Float32Array>>;
  putEmbeddings(model: string, items: { id: string; vec: Float32Array }[]): Promise<void>;
  clearEmbeddings(): Promise<void>;
  getTranscript(videoId: string): Promise<Transcript | undefined>;
  putTranscript(t: Transcript): Promise<void>;
  deleteTranscripts(): Promise<void>;
  countTranscripts(): Promise<number>;
  /** BM25 natif (FTS5) ; absent = BM25 maison côté moteur. Scores positifs, plus grand = mieux. */
  keywordSearch?(query: string, limit: number): Promise<{ id: string; score: number }[] | null>;
  clearAll(): Promise<void>;
}

export class MemoryKnStore implements KnStore {
  readonly engine = 'memory' as const;
  private p = new Map<string, KnPrinciple>();
  private s = new Map<string, KnSource>();
  private e = new Map<string, { model: string; vec: Float32Array }>();
  private t = new Map<string, Transcript>();
  async init() { /* rien */ }
  async allPrinciples() { return [...this.p.values()]; }
  async putPrinciples(ps: KnPrinciple[]) { for (const x of ps) this.p.set(x.id, x); }
  async deletePrinciples(ids: string[]) { for (const id of ids) { this.p.delete(id); this.e.delete(id); } }
  async allSources() { return [...this.s.values()]; }
  async putSource(x: KnSource) { this.s.set(x.id, x); }
  async deleteSource(id: string) { this.s.delete(id); }
  async allEmbeddings(model: string) { const m = new Map<string, Float32Array>(); for (const [id, v] of this.e) if (v.model === model) m.set(id, v.vec); return m; }
  async putEmbeddings(model: string, items: { id: string; vec: Float32Array }[]) { for (const i of items) this.e.set(i.id, { model, vec: i.vec }); }
  async clearEmbeddings() { this.e.clear(); }
  async getTranscript(videoId: string) { return this.t.get(videoId); }
  async putTranscript(t: Transcript) { this.t.set(t.videoId, t); }
  async deleteTranscripts() { this.t.clear(); }
  async countTranscripts() { return this.t.size; }
  async clearAll() { this.p.clear(); this.s.clear(); this.e.clear(); }
}

export async function createStore(): Promise<KnStore> {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (isTauri) {
    const { SqliteKnStore } = await import('./sqlite');
    const s = new SqliteKnStore(); await s.init(); return s;
  }
  if (typeof indexedDB !== 'undefined') {
    try { const { IdbKnStore } = await import('./idb'); const s = new IdbKnStore(); await s.init(); return s; }
    catch { /* IndexedDB bloqué (navigation privée…) → mémoire */ }
  }
  const m = new MemoryKnStore(); await m.init(); return m;
}
