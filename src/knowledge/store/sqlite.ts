// Stockage SQLite (Tauri) : tables kn_* dans prisme.db + index plein texte FTS5 (BM25 natif).
import type { Transcript } from '../api';
import type { KnPrinciple, KnSource } from '../types';
import type { KnStore } from './store';
import { base64ToVec, vecToBase64 } from '../search/vector';
import { ftsMatchExpression } from '../search/bm25';

type Db = { execute(q: string, a?: unknown[]): Promise<unknown>; select<T>(q: string, a?: unknown[]): Promise<T> };

let dbPromise: Promise<Db> | null = null;
function openDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = import('@tauri-apps/plugin-sql')
      .then(({ default: Database }) => Database.load('sqlite:prisme.db') as Promise<Db>)
      .catch((e) => { dbPromise = null; throw new Error('Base SQLite inaccessible : ' + (e instanceof Error ? e.message : String(e))); });
  }
  return dbPromise;
}

interface PrincipleRow { id: string; topic: string; title: string; text: string; source: string; source_id: string | null; origin: string; hash: string; created_at: number }

export class SqliteKnStore implements KnStore {
  readonly engine = 'sqlite' as const;
  private db!: Db;
  private fts = false;

  async init() {
    const d = this.db = await openDb();
    await d.execute(`CREATE TABLE IF NOT EXISTS kn_sources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, creator TEXT NOT NULL, video_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    await d.execute(`CREATE TABLE IF NOT EXISTS kn_principles(id TEXT PRIMARY KEY, topic TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, creator TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT, origin TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS kn_principles_topic ON kn_principles(topic)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS kn_principles_source ON kn_principles(source_id)`);
    await d.execute(`CREATE TABLE IF NOT EXISTS kn_embeddings(principle_id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec TEXT NOT NULL)`);
    await d.execute(`CREATE TABLE IF NOT EXISTS kn_transcripts(video_id TEXT PRIMARY KEY, provider TEXT NOT NULL, language TEXT, timed INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, fetched_at INTEGER NOT NULL)`);
    try {
      await d.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS kn_fts USING fts5(principle_id UNINDEXED, title, text, creator, tokenize = 'unicode61 remove_diacritics 2')`);
      this.fts = true;
    } catch { this.fts = false; }
  }

  /** INSERT multi-lignes par paquets (≤ 900 paramètres). */
  private async insertMany(table: string, cols: string[], rows: unknown[][], verb = 'INSERT OR REPLACE') {
    const per = Math.max(1, Math.floor(900 / cols.length));
    for (let i = 0; i < rows.length; i += per) {
      const params: unknown[] = [];
      const values = rows.slice(i, i + per).map(r => '(' + r.map(v => { params.push(v); return '$' + params.length; }).join(',') + ')').join(',');
      await this.db.execute(`${verb} INTO ${table}(${cols.join(',')}) VALUES ${values}`, params);
    }
  }
  private async deleteIn(table: string, col: string, ids: string[]) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await this.db.execute(`DELETE FROM ${table} WHERE ${col} IN (${chunk.map((_, j) => '$' + (j + 1)).join(',')})`, chunk);
    }
  }

  async allPrinciples(): Promise<KnPrinciple[]> {
    const rows = await this.db.select<PrincipleRow[]>('SELECT id, topic, title, text, source, source_id, origin, hash, created_at FROM kn_principles ORDER BY created_at, rowid');
    return rows.map(r => ({
      id: r.id, topic: r.topic as KnPrinciple['topic'], title: r.title, text: r.text, source: JSON.parse(r.source) as KnPrinciple['source'],
      sourceId: r.source_id ?? undefined, origin: r.origin as KnPrinciple['origin'], hash: r.hash, createdAt: r.created_at,
    }));
  }
  async putPrinciples(ps: KnPrinciple[]) {
    if (!ps.length) return;
    await this.insertMany('kn_principles', ['id', 'topic', 'title', 'text', 'creator', 'source', 'source_id', 'origin', 'hash', 'created_at'],
      ps.map(p => [p.id, p.topic, p.title, p.text, p.source.creator, JSON.stringify(p.source), p.sourceId ?? null, p.origin, p.hash, p.createdAt]));
    if (this.fts) {
      await this.deleteIn('kn_fts', 'principle_id', ps.map(p => p.id));
      await this.insertMany('kn_fts', ['principle_id', 'title', 'text', 'creator'], ps.map(p => [p.id, p.title, p.text, p.source.creator]), 'INSERT');
    }
  }
  async deletePrinciples(ids: string[]) {
    if (!ids.length) return;
    await this.deleteIn('kn_principles', 'id', ids);
    await this.deleteIn('kn_embeddings', 'principle_id', ids);
    if (this.fts) await this.deleteIn('kn_fts', 'principle_id', ids);
  }

  async allSources(): Promise<KnSource[]> {
    const rows = await this.db.select<{ data: string }[]>('SELECT data FROM kn_sources ORDER BY updated_at DESC');
    return rows.map(r => JSON.parse(r.data) as KnSource);
  }
  async putSource(s: KnSource) {
    await this.db.execute('INSERT OR REPLACE INTO kn_sources(id, kind, creator, video_id, status, data, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [s.id, s.kind, s.creator, s.videoId ?? null, s.status, JSON.stringify(s), s.updatedAt]);
  }
  async deleteSource(id: string) { await this.db.execute('DELETE FROM kn_sources WHERE id=$1', [id]); }

  async allEmbeddings(model: string) {
    const rows = await this.db.select<{ principle_id: string; vec: string }[]>('SELECT principle_id, vec FROM kn_embeddings WHERE model=$1', [model]);
    const m = new Map<string, Float32Array>();
    for (const r of rows) { try { m.set(r.principle_id, base64ToVec(r.vec)); } catch { /* ligne corrompue ignorée */ } }
    return m;
  }
  async putEmbeddings(model: string, items: { id: string; vec: Float32Array }[]) {
    if (!items.length) return;
    await this.insertMany('kn_embeddings', ['principle_id', 'model', 'dim', 'vec'], items.map(i => [i.id, model, i.vec.length, vecToBase64(i.vec)]));
  }
  async clearEmbeddings() { await this.db.execute('DELETE FROM kn_embeddings'); }

  async getTranscript(videoId: string): Promise<Transcript | undefined> {
    const r = await this.db.select<{ provider: string; language: string | null; timed: number; data: string }[]>(
      'SELECT provider, language, timed, data FROM kn_transcripts WHERE video_id=$1', [videoId]);
    if (!r[0]) return undefined;
    return { videoId, provider: r[0].provider as Transcript['provider'], language: r[0].language ?? undefined, timed: !!r[0].timed, segments: JSON.parse(r[0].data) };
  }
  async putTranscript(t: Transcript) {
    await this.db.execute('INSERT OR REPLACE INTO kn_transcripts(video_id, provider, language, timed, data, fetched_at) VALUES($1,$2,$3,$4,$5,$6)',
      [t.videoId, t.provider, t.language ?? null, t.timed === false ? 0 : 1, JSON.stringify(t.segments), Date.now()]);
  }
  async deleteTranscripts() { await this.db.execute('DELETE FROM kn_transcripts'); }
  async countTranscripts() { const r = await this.db.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM kn_transcripts'); return r[0]?.n ?? 0; }

  async keywordSearch(query: string, limit: number) {
    if (!this.fts) return null;
    const match = ftsMatchExpression(query);
    if (!match) return [];
    try {
      const rows = await this.db.select<{ id: string; rank: number }[]>(
        'SELECT principle_id AS id, bm25(kn_fts, 0.0, 3.0, 1.0, 0.5) AS rank FROM kn_fts WHERE kn_fts MATCH $1 ORDER BY rank LIMIT $2', [match, limit]);
      return rows.map(r => ({ id: r.id, score: Math.max(1e-6, -r.rank) }));
    } catch { return null; }
  }

  async clearAll() {
    await this.db.execute('DELETE FROM kn_principles');
    await this.db.execute('DELETE FROM kn_sources');
    await this.db.execute('DELETE FROM kn_embeddings');
    if (this.fts) await this.db.execute('DELETE FROM kn_fts');
  }
}
