// Synchro en arrière-plan : un planificateur par connecteur (syncIntervalMin, réglable),
// pause hors-ligne (navigator.onLine), reprise automatique, backoff exponentiel après échec.
import { create } from 'zustand';
import { connectors, type Connector } from '../api';
import { repo } from '../../db/store';
import { usePages } from '../../db/pages';
import { backoffDelayMs, errorMessage, isNetworkError, isOffline } from './errors';

export interface SyncState {
  status: 'idle' | 'running' | 'error' | 'offline' | 'disconnected';
  lastSync?: number; lastAttempt?: number; lastError?: string; nextRun?: number; failures: number;
}
interface SyncStore { online: boolean; started: boolean; states: Record<string, SyncState> }

export const useSync = create<SyncStore>(() => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, started: false, states: {},
}));

const STATE_KV = (id: string) => `connectors:sync:${id}`;
const INTERVAL_KV = 'connectors:sync:intervals';
const TICK_MS = 30_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
let overrides: Record<string, number> = {};
let timer: ReturnType<typeof setInterval> | undefined;
const running = new Set<string>();

const patch = (id: string, p: Partial<SyncState>) =>
  useSync.setState(s => ({ states: { ...s.states, [id]: { status: 'idle', failures: 0, ...s.states[id], ...p } } }));

export const intervalOf = (c: Pick<Connector, 'id' | 'syncIntervalMin'>) => overrides[c.id] ?? c.syncIntervalMin ?? 60;

/** Modifie la fréquence de synchro d'un connecteur (minutes). */
export async function setSyncInterval(id: string, minutes: number) {
  const m = Math.max(1, Math.round(minutes));
  overrides = { ...overrides, [id]: m };
  await repo.kvSet(INTERVAL_KV, overrides);
  const st = useSync.getState().states[id];
  patch(id, { nextRun: Math.max(Date.now() + 5_000, (st?.lastSync ?? Date.now()) + m * 60_000) });
}

/** Les synchros qui écrivent dans des bases attendent que les pages soient chargées (sinon doublons). */
function waitForPages(timeoutMs = 30_000): Promise<boolean> {
  if (usePages.getState().loaded) return Promise.resolve(true);
  return new Promise(resolve => {
    const unsub = usePages.subscribe(s => { if (s.loaded) { clearTimeout(t); unsub(); resolve(true); } });
    const t = setTimeout(() => { unsub(); resolve(usePages.getState().loaded); }, timeoutMs);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Synchro interrompue après ${Math.round(ms / 60_000)} min sans réponse.`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Lance la synchro d'un connecteur (manual = déclenchée par l'utilisateur : les erreurs remontent). */
export async function runSync(c: Connector, manual = false): Promise<void> {
  if (!c.sync || running.has(c.id)) return;
  const interval = intervalOf(c) * 60_000;
  if (isOffline()) {
    patch(c.id, { status: 'offline' });
    if (manual) throw new Error('Hors ligne : la synchro reprendra automatiquement au retour du réseau.');
    return;
  }
  const accounts = await c.accounts().catch(() => []);
  if (!accounts.length) {
    patch(c.id, { status: 'disconnected', nextRun: Date.now() + interval });
    if (manual) throw new Error(`${c.name} n’est pas connecté.`);
    return;
  }
  if (!(await waitForPages())) {
    patch(c.id, { nextRun: Date.now() + 60_000 });
    if (manual) throw new Error('Les pages ne sont pas encore chargées — réessaie dans un instant.');
    return;
  }
  running.add(c.id);
  patch(c.id, { status: 'running', lastAttempt: Date.now() });
  try {
    await withTimeout(c.sync(), RUN_TIMEOUT_MS);
    const now = Date.now();
    patch(c.id, { status: 'idle', lastSync: now, lastError: undefined, failures: 0, nextRun: now + interval });
    await repo.kvSet(STATE_KV(c.id), { lastSync: now });
  } catch (e) {
    const offline = isNetworkError(e);
    const failures = (useSync.getState().states[c.id]?.failures ?? 0) + 1;
    const delay = backoffDelayMs(failures, intervalOf(c), { jitter: Math.random() * 0.2 });
    patch(c.id, { status: offline ? 'offline' : 'error', lastError: errorMessage(e), failures, nextRun: Date.now() + delay });
    await repo.kvSet(STATE_KV(c.id), { lastSync: useSync.getState().states[c.id]?.lastSync, lastError: errorMessage(e) }).catch(() => undefined);
    if (manual) throw e;
  } finally {
    running.delete(c.id);
  }
}

export async function syncNow(id: string) {
  const c = connectors.find(x => x.id === id);
  if (c) await runSync(c, true);
}

/** Synchronise tous les connecteurs (en parallèle) ; renvoie les erreurs éventuelles. */
export async function syncAll(): Promise<string[]> {
  const res = await Promise.allSettled(connectors.filter(c => c.sync).map(c => runSync(c, true)));
  return res.flatMap((r, i) => (r.status === 'rejected' ? [`${connectors.filter(c => c.sync)[i].name} : ${errorMessage(r.reason)}`] : []));
}

function tick() {
  if (!useSync.getState().online) return;
  const now = Date.now();
  for (const c of connectors) {
    if (!c.sync) continue;
    const st = useSync.getState().states[c.id];
    if (!st?.nextRun || st.nextRun <= now) void runSync(c);
  }
}

/** Démarre le planificateur (idempotent). */
export async function startScheduler() {
  if (useSync.getState().started || typeof window === 'undefined') return;
  useSync.setState({ started: true });
  overrides = (await repo.kvGet<Record<string, number>>(INTERVAL_KV).catch(() => undefined)) ?? {};
  let stagger = 0;
  for (const c of connectors) {
    if (!c.sync) continue;
    const saved = await repo.kvGet<{ lastSync?: number; lastError?: string }>(STATE_KV(c.id)).catch(() => undefined);
    stagger += 20_000;
    const due = (saved?.lastSync ?? 0) + intervalOf(c) * 60_000;
    patch(c.id, { lastSync: saved?.lastSync, lastError: saved?.lastError, status: saved?.lastError ? 'error' : 'idle', nextRun: Math.max(due, Date.now() + stagger) });
  }
  window.addEventListener('online', () => {
    useSync.setState({ online: true });
    for (const c of connectors) if (c.sync && useSync.getState().states[c.id]?.status === 'offline') patch(c.id, { status: 'idle', nextRun: Date.now() + 3_000 });
    setTimeout(tick, 3_500);
  });
  window.addEventListener('offline', () => {
    useSync.setState({ online: false });
    for (const c of connectors) if (c.sync && useSync.getState().states[c.id]?.status !== 'running') patch(c.id, { status: 'offline' });
  });
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5_000);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
  useSync.setState({ started: false });
}
