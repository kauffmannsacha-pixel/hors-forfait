// Cache local à durée de vie (TTL) : mémoire + persistance (repo kv) pour le mode hors-ligne.
// Les entrées expirées restent lisibles en secours (réseau coupé) : « stale-if-error ».
import { isNetworkError, isOffline } from './errors';

export interface CacheEntry<T> { v: T; at: number; exp: number }
export interface KvBackend { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void> }
export interface WrapResult<T> { value: T; stale: boolean; at: number; fromCache: boolean }

export const isFresh = (e: Pick<CacheEntry<unknown>, 'exp'> | undefined | null, now: number) => !!e && e.exp > now;

const PREFIX = 'cache:';
const INDEX = 'cache:index';

export class TtlCache {
  private mem = new Map<string, CacheEntry<unknown>>();
  private inflight = new Map<string, Promise<WrapResult<unknown>>>();
  private index: Record<string, number> | null = null;
  private indexLoad: Promise<Record<string, number>> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private backend: KvBackend, private now: () => number = Date.now, private maxEntries = 400) {}

  private async loadIndex(): Promise<Record<string, number>> {
    if (this.index) return this.index;
    this.indexLoad ??= this.backend.get<Record<string, number>>(INDEX).then(i => (this.index = i && typeof i === 'object' ? i : {})).catch(() => (this.index = {}));
    return this.indexLoad;
  }

  /** Entrée brute (même expirée). */
  async peek<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const m = this.mem.get(key) as CacheEntry<T> | undefined;
    if (m) return m;
    try {
      const e = await this.backend.get<CacheEntry<T> | null>(PREFIX + key);
      if (e && typeof e === 'object' && 'exp' in e) { this.mem.set(key, e); return e; }
    } catch { /* stockage indisponible : on ignore */ }
    return undefined;
  }

  /** Valeur si encore fraîche. */
  async get<T>(key: string): Promise<T | undefined> {
    const e = await this.peek<T>(key);
    return isFresh(e, this.now()) ? e!.v : undefined;
  }

  async set<T>(key: string, v: T, ttlMs: number): Promise<void> {
    const at = this.now();
    const e: CacheEntry<T> = { v, at, exp: at + Math.max(0, ttlMs) };
    this.mem.set(key, e);
    this.writeChain = this.writeChain.then(async () => {
      const idx = await this.loadIndex();
      idx[key] = e.exp;
      await this.backend.set(PREFIX + key, e).catch(() => undefined);
      await this.evict(idx);
      await this.backend.set(INDEX, idx).catch(() => undefined);
    });
    return this.writeChain;
  }

  private async evict(idx: Record<string, number>) {
    const keys = Object.keys(idx);
    if (keys.length <= this.maxEntries) return;
    const victims = keys.sort((a, b) => idx[a] - idx[b]).slice(0, keys.length - this.maxEntries);
    for (const k of victims) { delete idx[k]; this.mem.delete(k); await this.backend.set(PREFIX + k, null).catch(() => undefined); }
  }

  /** Supprime les entrées dont la clé commence par `prefix` (tout si vide). */
  async invalidate(prefix = ''): Promise<number> {
    let n = 0;
    for (const k of [...this.mem.keys()]) if (k.startsWith(prefix)) this.mem.delete(k);
    this.writeChain = this.writeChain.then(async () => {
      const idx = await this.loadIndex();
      for (const k of Object.keys(idx)) if (k.startsWith(prefix)) { delete idx[k]; n++; await this.backend.set(PREFIX + k, null).catch(() => undefined); }
      await this.backend.set(INDEX, idx).catch(() => undefined);
    });
    await this.writeChain;
    return n;
  }

  /**
   * Renvoie la valeur fraîche du cache, sinon appelle `fetcher` (requêtes identiques mutualisées).
   * En cas d'erreur réseau (ou hors ligne), renvoie la dernière valeur connue marquée `stale`.
   */
  async wrap<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, opts: { force?: boolean; staleOnError?: (e: unknown) => boolean } = {}): Promise<WrapResult<T>> {
    const staleOk = opts.staleOnError ?? ((e: unknown) => isNetworkError(e));
    const cur = await this.peek<T>(key);
    if (!opts.force && cur && isFresh(cur, this.now())) return { value: cur.v, stale: false, at: cur.at, fromCache: true };
    if (cur && isOffline()) return { value: cur.v, stale: true, at: cur.at, fromCache: true };
    const running = this.inflight.get(key) as Promise<WrapResult<T>> | undefined;
    if (running) return running;
    const p = (async (): Promise<WrapResult<T>> => {
      try {
        const v = await fetcher();
        await this.set(key, v, ttlMs);
        return { value: v, stale: false, at: this.now(), fromCache: false };
      } catch (e) {
        if (cur && staleOk(e)) return { value: cur.v, stale: true, at: cur.at, fromCache: true };
        throw e;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p as Promise<WrapResult<unknown>>);
    return p;
  }
}

/** Clé de cache stable pour des paramètres (ordre des clés indifférent). */
export function stableKey(params: Record<string, unknown> = {}): string {
  return Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '').sort().map(k => `${k}=${String(params[k])}`).join('&');
}

// Instance partagée (repo kv : SQLite dans l'app, localStorage en dev).
let shared: TtlCache | null = null;
export function sharedCache(): TtlCache {
  if (!shared) {
    shared = new TtlCache({
      get: async <T,>(k: string) => (await import('../../db/store')).repo.kvGet<T>(k),
      set: async (k: string, v: unknown) => (await import('../../db/store')).repo.kvSet(k, v),
    });
  }
  return shared;
}
