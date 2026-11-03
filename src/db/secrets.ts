// Secrets : coffre Windows (keyring, commandes Rust) ; repli mémoire en navigateur.
import { isTauri } from './store';
const mem = new Map<string, string>();
async function inv<T>(cmd: string, args: Record<string, unknown>): Promise<T> { const { invoke } = await import('@tauri-apps/api/core'); return invoke<T>(cmd, args); }
export const secrets = {
  get: async (key: string) => (isTauri ? inv<string | null>('secret_get', { key }) : mem.get(key) ?? null),
  set: async (key: string, value: string) => { isTauri ? await inv('secret_set', { key, value }) : mem.set(key, value); },
  del: async (key: string) => { isTauri ? await inv('secret_del', { key }) : mem.delete(key); },
};
