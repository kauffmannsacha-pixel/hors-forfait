// Moteur de la base de connaissances : stockage, pré-remplissage, recherche hybride (cosinus + BM25), ajout dédoublonné,
// indexation sémantique en arrière-plan.
import { create } from 'zustand';
import { repo, uid } from '../db/store';
import type { Principle, Topic, Transcript } from './api';
import type { KnPrinciple, KnSource, Origin, SeedFile, SeedVideo } from './types';
import { createStore, type KnStore } from './store/store';
import { Bm25Index } from './search/bm25';
import { dot } from './search/vector';
import { fuseScores } from './search/hybrid';
import { DedupeIndex } from './ingest/dedupe';
import { principleHash } from './text';
import { embedTexts, isModelReady, loadModel, setModel, useModel } from './embed/client';
import { getSettings, KV } from './settings';

export type NewPrinciple = Omit<KnPrinciple, 'id' | 'hash' | 'createdAt' | 'score'>;
export interface SearchResult extends Principle { semantic?: number; keyword?: number }
export interface SearchOutcome { results: SearchResult[]; mode: 'hybrid' | 'keyword' | 'all' }

/** État de l'indexation sémantique (affiché dans la vue). */
export const useIndexState = create<{ indexing: boolean; done: number; total: number; error?: string }>(() => ({ indexing: false, done: 0, total: 0 }));

const embedText = (p: { title: string; text: string }) => `${p.title}. ${p.text}`;
export const toPrinciple = (p: KnPrinciple, score?: number): Principle => ({ id: p.id, topic: p.topic, title: p.title, text: p.text, source: p.source, ...(score != null ? { score } : {}) });
const originOf = (kind: Principle['source']['kind']): Origin => kind === 'ab-test' ? 'ab-test' : kind === 'document' ? 'document' : kind === 'youtube' ? 'ingest' : 'manual';

class KnowledgeEngine {
  private store: KnStore | null = null;
  private initPromise: Promise<void> | null = null;
  private byId = new Map<string, KnPrinciple>();
  private srcs = new Map<string, KnSource>();
  private vectors = new Map<string, Float32Array>();
  private bm25: Bm25Index | null = null;
  private qCache = new Map<string, Float32Array>();
  private sorted: KnPrinciple[] | null = null;
  private indexing: Promise<number> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  initError: string | null = null;

  // ── abonnement (useSyncExternalStore) ──
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private bump() { this.version++; this.sorted = null; for (const l of this.listeners) l(); }

  get storageEngine() { return this.store?.engine ?? null; }
  get ready() { return !!this.store; }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((e) => {
        this.initError = e instanceof Error ? e.message : String(e);
        this.initPromise = null;
        this.bump();
        throw e;
      });
    }
    return this.initPromise;
  }

  private async doInit() {
    const settings = await getSettings();
    setModel(settings.model);
    const store = await createStore();
    const [ps, srcs, vecs] = await Promise.all([store.allPrinciples(), store.allSources(), store.allEmbeddings(settings.model)]);
    this.store = store;
    for (const p of ps) this.byId.set(p.id, p);
    for (const s of srcs) this.srcs.set(s.id, s);
    this.vectors = vecs;
    this.initError = null;
    await this.applySeed().catch(() => undefined);
    this.bump();
  }

  private async st(): Promise<KnStore> { await this.init(); return this.store!; }

  // ── pré-remplissage ──
  async loadSeed(): Promise<SeedFile> { return (await import('./seed.json')).default as unknown as SeedFile; }

  /** Charge seed.json au premier lancement (ou nouvelle version) ; force = réimporte aussi les principes supprimés. */
  async applySeed(force = false): Promise<number> {
    const store = this.store ?? await this.st();
    const seed = await this.loadSeed();
    const done = await repo.kvGet<number>(KV.seedVersion);
    if (!force && done != null && done >= seed.version) return 0;
    const deleted = new Set(force ? [] : (await repo.kvGet<string[]>(KV.seedDeleted)) ?? []);
    const base = Date.now();
    const add: KnPrinciple[] = seed.principles
      .filter(p => !this.byId.has(p.id) && !deleted.has(p.id))
      .map((p, i) => ({ id: p.id, topic: p.topic, title: p.title, text: p.text, source: p.source, origin: 'seed', hash: principleHash(p.title, p.text), createdAt: base - i }));
    if (add.length) { await store.putPrinciples(add); for (const p of add) { this.byId.set(p.id, p); this.bm25?.add(p.id, this.bmFields(p)); } }
    await repo.kvSet(KV.seedVersion, seed.version);
    if (force) await repo.kvSet(KV.seedDeleted, []);
    if (add.length) this.bump();
    return add.length;
  }

  /** File de vidéos vérifiées à ingérer en priorité. */
  async seedQueue(): Promise<SeedVideo[]> { return (await this.loadSeed()).videos ?? []; }

  // ── lecture ──
  list(): KnPrinciple[] {
    if (!this.sorted) this.sorted = [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    return this.sorted;
  }
  get(id: string) { return this.byId.get(id); }
  sources(): KnSource[] { return [...this.srcs.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  source(id: string) { return this.srcs.get(id); }
  embeddedCount() { let n = 0; for (const id of this.byId.keys()) if (this.vectors.has(id)) n++; return n; }
  async transcriptCount() { return (await this.st()).countTranscripts(); }

  // ── recherche ──
  private bmFields(p: KnPrinciple) { return [{ text: p.title, weight: 2 }, { text: p.text, weight: 1 }, { text: p.source.creator, weight: 0.5 }]; }
  private ensureBm25(): Bm25Index {
    if (!this.bm25) { const idx = new Bm25Index(); for (const p of this.byId.values()) idx.add(p.id, this.bmFields(p)); this.bm25 = idx; }
    return this.bm25;
  }
  private async keywordScores(query: string, pool: Set<string>): Promise<Map<string, number>> {
    const store = await this.st();
    if (store.keywordSearch) {
      const r = await store.keywordSearch(query, 400);
      if (r) return new Map(r.filter(x => pool.has(x.id)).map(x => [x.id, x.score]));
    }
    return new Map(this.ensureBm25().search(query, { limit: 400, filter: id => pool.has(id) }).map(x => [x.id, x.score]));
  }
  private async embedQuery(q: string): Promise<Float32Array> {
    const key = q.trim().toLowerCase();
    const hit = this.qCache.get(key); if (hit) return hit;
    const [v] = await embedTexts([q]);
    this.qCache.set(key, v);
    if (this.qCache.size > 64) this.qCache.delete(this.qCache.keys().next().value as string);
    return v;
  }

  /** Recherche hybride : cosinus (si le modèle est chargé) + BM25 ; repli mots-clés sinon. */
  async searchDetailed(query: string, opts: { topic?: Topic; k?: number } = {}): Promise<SearchOutcome> {
    await this.init();
    const k = Math.max(1, opts.k ?? 6);
    const pool = this.list().filter(p => !opts.topic || p.topic === opts.topic);
    if (!query.trim()) return { results: pool.slice(0, k).map(p => toPrinciple(p)), mode: 'all' };
    const ids = new Set(pool.map(p => p.id));
    const settings = await getSettings();
    const kw = await this.keywordScores(query, ids);
    let cos: Map<string, number> | null = null;
    if (settings.semantic && isModelReady() && this.vectors.size) {
      try {
        const qv = await this.embedQuery(query);
        cos = new Map();
        for (const id of ids) { const v = this.vectors.get(id); if (v && v.length === qv.length) cos.set(id, dot(qv, v)); }
        if (!cos.size) cos = null;
      } catch { cos = null; }
    } else if (settings.semantic && useModel.getState().status === 'idle') {
      void this.warmup();
    }
    const fused = fuseScores(kw, cos);
    return {
      mode: cos ? 'hybrid' : 'keyword',
      results: fused.slice(0, k).map(f => ({ ...toPrinciple(this.byId.get(f.id)!, Math.round(f.score * 1000) / 1000), semantic: f.semantic, keyword: f.keyword })),
    };
  }
  search = async (query: string, opts?: { topic?: Topic; k?: number }): Promise<Principle[]> =>
    (await this.searchDetailed(query, opts)).results.map(({ semantic: _s, keyword: _k, ...p }) => p);

  /** Charge le modèle s'il a déjà été téléchargé (sinon ne télécharge rien). */
  async warmup(): Promise<void> {
    const s = await getSettings();
    if (!s.semantic || isModelReady()) return;
    if (!(await repo.kvGet<boolean>(KV.modelReadyOnce))) return;
    try { await loadModel(s.model); } catch { /* repli mots-clés */ }
  }

  // ── écriture ──
  /** Ajoute des principes en écartant les doublons (exacts, lexicaux, sémantiques). */
  async addPrinciples(items: NewPrinciple[], opts: { dedupe?: boolean } = {}): Promise<{ added: KnPrinciple[]; duplicates: { index: number; existingId: string }[] }> {
    const store = await this.st();
    const settings = await getSettings();
    const clean = items.map(i => ({ ...i, title: i.title.trim(), text: i.text.trim() })).filter(i => i.title && i.text);
    let vecs: Float32Array[] | null = null;
    if (settings.semantic && isModelReady() && clean.length) { try { vecs = await embedTexts(clean.map(embedText)); } catch { vecs = null; } }
    const index = opts.dedupe === false ? null : new DedupeIndex(this.list().map(p => ({ id: p.id, title: p.title, text: p.text, vec: this.vectors.get(p.id) })));
    const added: KnPrinciple[] = []; const duplicates: { index: number; existingId: string }[] = [];
    const now = Date.now();
    clean.forEach((it, i) => {
      const vec = vecs?.[i];
      const dup = index?.find({ title: it.title, text: it.text, vec });
      if (dup) { duplicates.push({ index: i, existingId: dup }); return; }
      const p: KnPrinciple = { ...it, id: uid(), hash: principleHash(it.title, it.text), createdAt: now + i };
      added.push(p);
      index?.add(p.id, { title: p.title, text: p.text, vec });
    });
    if (added.length) {
      await store.putPrinciples(added);
      const withVec = vecs ? added.map(p => ({ id: p.id, vec: vecs![clean.findIndex(c => c.title === p.title && c.text === p.text)] })).filter(x => x.vec) : [];
      if (withVec.length) await store.putEmbeddings(settings.model, withVec);
      for (const p of added) { this.byId.set(p.id, p); this.bm25?.add(p.id, this.bmFields(p)); }
      for (const w of withVec) this.vectors.set(w.id, w.vec);
      this.bump();
      if (settings.semantic && withVec.length < added.length) void this.ensureIndex({ download: false }).catch(() => undefined);
    }
    return { added, duplicates };
  }

  /** Implémentation du contrat addPrinciple : renvoie le doublon existant si le principe est déjà connu. */
  add = async (p: Omit<Principle, 'id'>): Promise<Principle> => {
    const { added, duplicates } = await this.addPrinciples([{ topic: p.topic, title: p.title, text: p.text, source: p.source, origin: originOf(p.source.kind) }]);
    if (added[0]) return toPrinciple(added[0]);
    const ex = duplicates[0] && this.byId.get(duplicates[0].existingId);
    if (ex) return toPrinciple(ex);
    throw new Error('Principe vide : titre et texte sont obligatoires.');
  };

  async updatePrinciple(id: string, patch: Partial<Pick<KnPrinciple, 'topic' | 'title' | 'text' | 'source'>>) {
    const store = await this.st();
    const cur = this.byId.get(id); if (!cur) return;
    const next: KnPrinciple = { ...cur, ...patch };
    next.hash = principleHash(next.title, next.text);
    await store.putPrinciples([next]);
    this.byId.set(id, next); this.bm25?.add(id, this.bmFields(next));
    if (patch.title != null || patch.text != null) { this.vectors.delete(id); await store.deletePrinciples([]).catch(() => undefined); void this.ensureIndex({ download: false }).catch(() => undefined); }
    this.bump();
  }

  async remove(ids: string[]) {
    const store = await this.st();
    if (!ids.length) return;
    const seedIds = ids.filter(id => this.byId.get(id)?.origin === 'seed');
    await store.deletePrinciples(ids);
    for (const id of ids) { this.byId.delete(id); this.vectors.delete(id); this.bm25?.remove(id); }
    if (seedIds.length) {
      const prev = (await repo.kvGet<string[]>(KV.seedDeleted)) ?? [];
      await repo.kvSet(KV.seedDeleted, [...new Set([...prev, ...seedIds])]);
    }
    // Compteurs des sources concernées
    const touched = new Set<string>();
    for (const s of this.srcs.values()) touched.add(s.id);
    for (const sid of touched) {
      const s = this.srcs.get(sid)!; const n = this.list().filter(p => p.sourceId === sid).length;
      if (n !== s.principles && s.status === 'ok') { s.principles = n; await store.putSource(s); }
    }
    this.bump();
  }

  async upsertSource(s: KnSource) { const store = await this.st(); await store.putSource(s); this.srcs.set(s.id, s); this.bump(); }

  /** Supprime une source et les principes qui en viennent. */
  async removeSource(id: string) {
    const store = await this.st();
    const ids = this.list().filter(p => p.sourceId === id).map(p => p.id);
    if (ids.length) await this.remove(ids);
    await store.deleteSource(id);
    this.srcs.delete(id);
    this.bump();
  }

  async clearAll() {
    const store = await this.st();
    await store.clearAll();
    this.byId.clear(); this.srcs.clear(); this.vectors.clear(); this.bm25 = null; this.qCache.clear();
    await repo.kvSet(KV.seedDeleted, []);
    this.bump();
  }

  // ── transcriptions (cache) ──
  async getCachedTranscript(videoId: string) { return (await this.st()).getTranscript(videoId); }
  async putTranscript(t: Transcript) { await (await this.st()).putTranscript(t); this.bump(); }
  async clearTranscripts() { await (await this.st()).deleteTranscripts(); this.bump(); }

  // ── index sémantique ──
  /** Calcule les embeddings manquants. download = autorise le téléchargement du modèle s'il n'a jamais été chargé. */
  ensureIndex(opts: { download?: boolean; signal?: AbortSignal } = {}): Promise<number> {
    if (this.indexing) return this.indexing;
    this.indexing = this.doIndex(opts).finally(() => { this.indexing = null; });
    return this.indexing;
  }
  private async doIndex(opts: { download?: boolean; signal?: AbortSignal }): Promise<number> {
    const store = await this.st();
    const s = await getSettings();
    if (!s.semantic) return 0;
    if (!isModelReady()) {
      const once = await repo.kvGet<boolean>(KV.modelReadyOnce);
      if (!opts.download && !once) return 0;
      await loadModel(s.model);
      await repo.kvSet(KV.modelReadyOnce, true);
    }
    const missing = this.list().filter(p => !this.vectors.has(p.id));
    if (!missing.length) return 0;
    useIndexState.setState({ indexing: true, done: 0, total: missing.length, error: undefined });
    let done = 0;
    try {
      for (let i = 0; i < missing.length; i += 32) {
        if (opts.signal?.aborted) break;
        const batch = missing.slice(i, i + 32).filter(p => this.byId.has(p.id));
        const vecs = await embedTexts(batch.map(embedText), { signal: opts.signal });
        const items = batch.map((p, j) => ({ id: p.id, vec: vecs[j] }));
        await store.putEmbeddings(s.model, items);
        for (const it of items) this.vectors.set(it.id, it.vec);
        done += batch.length;
        useIndexState.setState({ done });
      }
      this.qCache.clear();
      return done;
    } catch (e) {
      useIndexState.setState({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      useIndexState.setState({ indexing: false });
      this.bump();
    }
  }

  /** Recalcule tout l'index (changement de modèle). */
  async rebuildIndex(opts: { download?: boolean } = { download: true }) {
    const store = await this.st();
    await store.clearEmbeddings();
    this.vectors.clear(); this.qCache.clear();
    this.bump();
    return this.ensureIndex(opts);
  }

  /** Recharge les embeddings du modèle courant (après changement de modèle dans les réglages). */
  async reloadVectors() {
    const store = await this.st(); const s = await getSettings();
    this.vectors = await store.allEmbeddings(s.model); this.qCache.clear(); this.bump();
  }
}

export const engine = new KnowledgeEngine();
