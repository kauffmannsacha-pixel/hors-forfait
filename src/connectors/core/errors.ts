// Erreurs lisibles (en français) + utilitaires réseau communs aux connecteurs.
export interface ConnectorErrorInfo {
  service?: string; status?: number; code?: string;
  retryable?: boolean;      // erreur passagère (429, 5xx…) : on peut réessayer
  retryAfterMs?: number;
  offline?: boolean;        // réseau indisponible
  cancelled?: boolean;      // annulé par l'utilisateur (pas de toast d'erreur)
  needsReauth?: boolean;    // jeton révoqué / expiré : reconnecter le compte
}

export class ConnectorError extends Error {
  info: ConnectorErrorInfo;
  constructor(message: string, info: ConnectorErrorInfo = {}) { super(message); this.name = 'ConnectorError'; this.info = info; }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const NET_RE = /failed to fetch|networkerror|network error|load failed|error sending request|dns|connection (refused|reset|closed)|timed? ?out|unreachable|no route|offline|tcp connect|certificate/i;

/** Erreur réseau (et non erreur applicative) ? */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof ConnectorError) return !!e.info.offline;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return NET_RE.test(msg) || (e instanceof TypeError && /fetch/i.test(msg));
}

export const isCancelled = (e: unknown) => e instanceof ConnectorError && !!e.info.cancelled;

/** Convertit une exception réseau en erreur lisible. */
export function networkError(service: string, e?: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  return new ConnectorError(isOffline()
    ? `${service} : tu es hors ligne — les données en cache restent consultables.`
    : `${service} : connexion impossible (${e instanceof Error ? e.message : 'réseau indisponible'}).`, { service, offline: true, retryable: true });
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e ?? 'Erreur inconnue'));

/** Réessaie les erreurs passagères avec un backoff exponentiel (+ gigue). */
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseMs?: number; maxMs?: number } = {}): Promise<T> {
  const { retries = 2, baseMs = 800, maxMs = 15_000 } = opts;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const retryable = e instanceof ConnectorError && e.info.retryable && !e.info.offline;
      if (!retryable || attempt >= retries) throw e;
      const wait = (e as ConnectorError).info.retryAfterMs ?? Math.min(maxMs, baseMs * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      await sleep(wait);
    }
  }
}

/** Délai avant la prochaine tentative de synchro après `failures` échecs consécutifs (backoff plafonné). */
export function backoffDelayMs(failures: number, intervalMin: number, opts: { baseMin?: number; capMin?: number; jitter?: number } = {}): number {
  const { baseMin = 1, capMin = 60, jitter = 0 } = opts;
  if (failures <= 0) return intervalMin * 60_000;
  const cap = Math.max(baseMin, Math.min(intervalMin, capMin));
  const min = Math.min(cap, baseMin * 2 ** (failures - 1));
  return Math.round(min * 60_000 * (1 + jitter));
}
