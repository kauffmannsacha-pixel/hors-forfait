// Cache des réponses (kv) pour économiser le quota YouTube : mémoire + SQLite (kv), requêtes simultanées dédoublonnées,
// et repli sur la dernière valeur connue si l'appel échoue (quota épuisé, hors-ligne).
import { repo } from '../../../db/store';

const PREFIX = 'stats.cache.';
interface Entry<T> { at: number; v: T }
export interface Fetched<T> {
  value: T;
  /** Date de récupération (ms). */
  at: number;
  fromCache: boolean;
  /** Renseigné si l'appel a échoué et qu'on affiche une donnée plus ancienne. */
  staleError?: string;
}

const mem = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<Fetched<unknown>>>();

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

async function readEntry<T>(key: string): Promise<Entry<T> | undefined> {
  const m = mem.get(key) as Entry<T> | undefined;
  if (m) return m;
  try {
    const e = await repo.kvGet<Entry<T>>(PREFIX + key);
    if (e && typeof e.at === 'number') { mem.set(key, e); return e; }
  } catch { /* base indisponible : on continue sans cache persistant */ }
  return undefined;
}

/**
 * Renvoie la valeur en cache si elle a moins de ttlMs, sinon appelle fetcher et mémorise.
 * force = ignore le cache (bouton « Actualiser »). En cas d'erreur, renvoie la dernière valeur connue (staleError).
 */
export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, opts: { force?: boolean; persist?: boolean } = {}): Promise<Fetched<T>> {
  const old = await readEntry<T>(key);
  if (!opts.force && old && Date.now() - old.at < ttlMs) return { value: old.v, at: old.at, fromCache: true };
  const running = inflight.get(key) as Promise<Fetched<T>> | undefined;
  if (running) return running;
  const p = (async (): Promise<Fetched<T>> => {
    try {
      const v = await fetcher();
      const e: Entry<T> = { at: Date.now(), v };
      mem.set(key, e);
      if (opts.persist !== false) {
        try { await repo.kvSet(PREFIX + key, e); } catch { /* stockage plein (navigateur) : cache mémoire seulement */ }
      }
      return { value: v, at: e.at, fromCache: false };
    } catch (err) {
      if (old) return { value: old.v, at: old.at, fromCache: true, staleError: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  })();
  inflight.set(key, p as Promise<Fetched<unknown>>);
  try { return await p; } finally { inflight.delete(key); }
}

/** Lecture seule du cache (sans appel réseau). */
export async function peek<T>(key: string): Promise<Fetched<T> | undefined> {
  const e = await readEntry<T>(key);
  return e ? { value: e.v, at: e.at, fromCache: true } : undefined;
}

/** Oublie une entrée (mémoire + kv). */
export async function forget(key: string): Promise<void> {
  mem.delete(key);
  try { await repo.kvSet(PREFIX + key, null); } catch { /* ignore */ }
}
