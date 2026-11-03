// Couche de persistance : SQLite (tauri-plugin-sql) dans l'app, localStorage dans le navigateur (dev/tests).
import type { Page, PageVersion, ID } from './types';
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const uid = () => crypto.randomUUID();

export interface Repo {
  listPages(): Promise<Page[]>;
  savePage(p: Page): Promise<void>;
  deletePage(id: ID): Promise<void>;
  addVersion(v: PageVersion): Promise<void>;
  listVersions(pageId: ID): Promise<PageVersion[]>;
  kvGet<T>(k: string): Promise<T | undefined>;
  kvSet(k: string, v: unknown): Promise<void>;
}

class LocalRepo implements Repo {
  private read<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem('prisme:' + k) ?? '') as T; } catch { return d; } }
  private write(k: string, v: unknown) { localStorage.setItem('prisme:' + k, JSON.stringify(v)); }
  async listPages() { return this.read<Page[]>('pages', []); }
  async savePage(p: Page) { const all = await this.listPages(); const i = all.findIndex(x => x.id === p.id); i >= 0 ? (all[i] = p) : all.push(p); this.write('pages', all); }
  async deletePage(id: ID) { this.write('pages', (await this.listPages()).filter(p => p.id !== id)); }
  async addVersion(v: PageVersion) { const all = this.read<PageVersion[]>('versions', []); all.push(v); this.write('versions', all.slice(-2000)); }
  async listVersions(pageId: ID) { return this.read<PageVersion[]>('versions', []).filter(v => v.pageId === pageId); }
  async kvGet<T>(k: string) { return this.read<T | undefined>('kv:' + k, undefined); }
  async kvSet(k: string, v: unknown) { this.write('kv:' + k, v); }
}

class SqliteRepo implements Repo {
  private db: Promise<{ execute(q: string, a?: unknown[]): Promise<unknown>; select<T>(q: string, a?: unknown[]): Promise<T> }>;
  constructor() {
    this.db = import('@tauri-apps/plugin-sql').then(async ({ default: Database }) => {
      const db = await Database.load('sqlite:prisme.db');
      await db.execute(`CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      await db.execute(`CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, page_id TEXT, data TEXT NOT NULL)`);
      await db.execute(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)`);
      await db.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(page_id UNINDEXED, title, body)`);
      return db;
    });
  }
  async listPages() { const r = await (await this.db).select<{ data: string }[]>('SELECT data FROM pages'); return r.map(x => JSON.parse(x.data) as Page); }
  async savePage(p: Page) {
    const db = await this.db;
    await db.execute('INSERT OR REPLACE INTO pages(id,data) VALUES($1,$2)', [p.id, JSON.stringify(p)]);
    await db.execute('DELETE FROM fts WHERE page_id=$1', [p.id]);
    await db.execute('INSERT INTO fts(page_id,title,body) VALUES($1,$2,$3)', [p.id, p.title, JSON.stringify(p.content).replace(/"[a-zA-Z]+":/g, ' ')]);
  }
  async deletePage(id: ID) { const db = await this.db; await db.execute('DELETE FROM pages WHERE id=$1', [id]); await db.execute('DELETE FROM fts WHERE page_id=$1', [id]); }
  async addVersion(v: PageVersion) { await (await this.db).execute('INSERT INTO versions(id,page_id,data) VALUES($1,$2,$3)', [v.id, v.pageId, JSON.stringify(v)]); }
  async listVersions(pageId: ID) { const r = await (await this.db).select<{ data: string }[]>('SELECT data FROM versions WHERE page_id=$1', [pageId]); return r.map(x => JSON.parse(x.data)); }
  async kvGet<T>(k: string) { const r = await (await this.db).select<{ v: string }[]>('SELECT v FROM kv WHERE k=$1', [k]); return r[0] ? (JSON.parse(r[0].v) as T) : undefined; }
  async kvSet(k: string, v: unknown) { await (await this.db).execute('INSERT OR REPLACE INTO kv(k,v) VALUES($1,$2)', [k, JSON.stringify(v)]); }
}

export const repo: Repo = isTauri ? new SqliteRepo() : new LocalRepo();
