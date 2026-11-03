// File d'attente de requêtes : limite de concurrence + espacement minimal (protège les quotas et limites de débit).
export class RequestQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  private lastStart = 0;

  constructor(private concurrency = 4, private minIntervalMs = 0) {}

  get pending() { return this.waiting.length; }
  get running() { return this.active; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(r => this.waiting.push(r));
    this.active++;
    try {
      if (this.minIntervalMs > 0) {
        const wait = this.lastStart + this.minIntervalMs - Date.now();
        this.lastStart = Math.max(Date.now(), this.lastStart + this.minIntervalMs);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Mutualise les appels identiques en cours (une seule requête réseau par clé). */
export function singleFlight<T>(map: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const cur = map.get(key);
  if (cur) return cur;
  const p = fn().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

/** Découpe un tableau en paquets de `size`. */
export const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const uniq = <T>(arr: T[]): T[] => [...new Set(arr)];
