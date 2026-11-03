// Stockage IndexedDB (navigateur / dev hors Tauri). Le BM25 est calculé en mémoire par le moteur.
import type { Transcript } from '../api';
import type { KnPrinciple, KnSource } from '../types';
import type { KnStore } from './store';

const DB_NAME = 'prisme-knowledge';
const VERSION = 1;
const STORES: [string, string][] = [['principles', 'id'], ['sources', 'id'], ['embeddings', 'id'], ['transcripts', 'videoId']];

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error('Transaction annulée')); });

interface EmbRow { id: string; model: string; vec: ArrayBuffer }
interface TrRow extends Transcript { fetchedAt: number }

export class IdbKnStore implements KnStore {
  readonly engine = 'indexeddb' as const;
  private db!: IDBDatabase;

  async init() {
    this.db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => { const d = r.result; for (const [name, keyPath] of STORES) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error ?? new Error('IndexedDB indisponible'));
      r.onblocked = () => rej(new Error('IndexedDB bloqué par un autre onglet'));
    });
  }
  private async getAll<T>(store: string): Promise<T[]> { return (await req(this.db.transaction(store, 'readonly').objectStore(store).getAll())) as T[]; }
  private async putAll(store: string, items: unknown[]) {
    if (!items.length) return;
    const tx = this.db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
    for (const i of items) os.put(i);
    await done(tx);
  }
  private async delAll(store: string, keys: string[]) {
    if (!keys.length) return;
    const tx = this.db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    await done(tx);
  }
  private async clear(store: string) { const tx = this.db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); await done(tx); }

  async allPrinciples() { return (await this.getAll<KnPrinciple>('principles')).sort((a, b) => a.createdAt - b.createdAt); }
  async putPrinciples(ps: KnPrinciple[]) { await this.putAll('principles', ps); }
  async deletePrinciples(ids: string[]) { await this.delAll('principles', ids); await this.delAll('embeddings', ids); }
  async allSources() { return (await this.getAll<KnSource>('sources')).sort((a, b) => b.updatedAt - a.updatedAt); }
  async putSource(s: KnSource) { await this.putAll('sources', [s]); }
  async deleteSource(id: string) { await this.delAll('sources', [id]); }
  async allEmbeddings(model: string) {
    const m = new Map<string, Float32Array>();
    for (const r of await this.getAll<EmbRow>('embeddings')) if (r.model === model) m.set(r.id, new Float32Array(r.vec));
    return m;
  }
  async putEmbeddings(model: string, items: { id: string; vec: Float32Array }[]) {
    await this.putAll('embeddings', items.map(i => ({ id: i.id, model, vec: i.vec.slice().buffer })));
  }
  async clearEmbeddings() { await this.clear('embeddings'); }
  async getTranscript(videoId: string) {
    const r = (await req(this.db.transaction('transcripts', 'readonly').objectStore('transcripts').get(videoId))) as TrRow | undefined;
    if (!r) return undefined;
    const { fetchedAt: _f, ...t } = r; void _f;
    return t as Transcript;
  }
  async putTranscript(t: Transcript) { await this.putAll('transcripts', [{ ...t, fetchedAt: Date.now() }]); }
  async deleteTranscripts() { await this.clear('transcripts'); }
  async countTranscripts() { return req(this.db.transaction('transcripts', 'readonly').objectStore('transcripts').count()); }
  async clearAll() { await this.clear('principles'); await this.clear('sources'); await this.clear('embeddings'); }
}
