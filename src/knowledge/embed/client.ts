// Client du Web Worker d'embeddings : chargement du modèle avec progression, file d'appels, état observable.
import { create } from 'zustand';

export const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
/** Taille approximative du modèle quantifié (q8), pour l'affichage. */
export const MODEL_SIZE_MB = 118;

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
export interface ModelState {
  status: ModelStatus;
  model: string;
  /** 0-100 pendant le téléchargement. */
  progress: number;
  loaded: number;
  total: number;
  file?: string;
  error?: string;
}

const supported = () => typeof Worker !== 'undefined';
export const useModel = create<ModelState>(() => ({ status: supported() ? 'idle' : 'unsupported', model: DEFAULT_MODEL, progress: 0, loaded: 0, total: 0 }));

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let loading: { model: string; promise: Promise<void> } | null = null;
const files = new Map<string, { loaded: number; total: number }>();

function onProgress(info: Record<string, unknown>) {
  const st = useModel.getState();
  if (st.status === 'ready') return;
  if (info.status === 'progress_total' && typeof info.progress === 'number') {
    useModel.setState({ progress: Math.min(100, info.progress), loaded: Number(info.loaded) || 0, total: Number(info.total) || 0 });
    return;
  }
  if (info.status === 'progress' && typeof info.file === 'string') {
    files.set(info.file, { loaded: Number(info.loaded) || 0, total: Number(info.total) || 0 });
    let loaded = 0, total = 0; for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    useModel.setState({ file: info.file, loaded, total, progress: total ? Math.min(100, (loaded / total) * 100) : st.progress });
  } else if (info.status === 'initiate' && typeof info.file === 'string') useModel.setState({ file: info.file });
}

function failAll(message: string) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
  loading = null;
  useModel.setState({ status: 'error', error: message });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  if (!supported()) throw new Error('Les Web Workers ne sont pas disponibles : recherche par mots-clés uniquement.');
  worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
    const m = e.data;
    if (m.type === 'progress') { onProgress((m.info ?? {}) as Record<string, unknown>); return; }
    const p = pending.get(m.id as number); if (!p) return;
    pending.delete(m.id as number);
    if (m.type === 'error') p.reject(new Error(humanizeModelError(String(m.message))));
    else p.resolve(m);
  };
  worker.onerror = (e) => { failAll('Le moteur d\'embeddings s\'est arrêté : ' + (e.message || 'erreur inconnue')); worker?.terminate(); worker = null; };
  return worker;
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject }); w.postMessage({ ...msg, id }); });
}

export function humanizeModelError(m: string): string {
  if (/fetch|network|Failed to fetch|NetworkError|ERR_/i.test(m)) return 'Téléchargement du modèle impossible (connexion internet ?) — recherche par mots-clés en attendant.';
  if (/quota|storage/i.test(m)) return 'Espace de cache insuffisant pour le modèle d\'embeddings.';
  return 'Modèle d\'embeddings : ' + m;
}

/** Charge (et télécharge au premier usage) le modèle dans le worker. */
export function loadModel(model = useModel.getState().model): Promise<void> {
  if (!supported()) return Promise.reject(new Error('Embeddings locaux indisponibles dans cet environnement.'));
  if (useModel.getState().status === 'ready' && useModel.getState().model === model) return Promise.resolve();
  if (loading && loading.model === model) return loading.promise;
  files.clear();
  useModel.setState({ status: 'loading', model, progress: 0, loaded: 0, total: 0, error: undefined, file: undefined });
  const promise = call<void>({ type: 'load', model })
    .then(() => { useModel.setState({ status: 'ready', progress: 100 }); })
    .catch((e: Error) => { loading = null; useModel.setState({ status: 'error', error: e.message }); throw e; });
  loading = { model, promise };
  return promise;
}

export const isModelReady = () => useModel.getState().status === 'ready';

/** Embeddings normalisés (cosinus = produit scalaire). */
export async function embedTexts(texts: string[], opts: { batch?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<Float32Array[]> {
  if (!texts.length) return [];
  await loadModel();
  const model = useModel.getState().model;
  const batch = opts.batch ?? 16;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batch) {
    if (opts.signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    const chunk = texts.slice(i, i + batch).map(t => t.slice(0, 1200));
    const r = await call<{ dim: number; count: number; buffer: ArrayBuffer }>({ type: 'embed', model, texts: chunk });
    const all = new Float32Array(r.buffer);
    for (let j = 0; j < r.count; j++) out.push(all.slice(j * r.dim, (j + 1) * r.dim));
    opts.onProgress?.(Math.min(texts.length, i + batch), texts.length);
  }
  return out;
}

/** Change de modèle (les embeddings existants deviennent obsolètes). */
export function setModel(model: string) {
  if (model === useModel.getState().model) return;
  loading = null;
  useModel.setState({ model, status: supported() ? 'idle' : 'unsupported', progress: 0, loaded: 0, total: 0, error: undefined });
}

/** Supprime le modèle du cache du navigateur (sera retéléchargé). */
export async function clearModelCache(): Promise<void> {
  worker?.terminate(); worker = null; loading = null; pending.clear();
  if (typeof caches !== 'undefined') await caches.delete('transformers-cache');
  useModel.setState({ status: supported() ? 'idle' : 'unsupported', progress: 0, loaded: 0, total: 0, error: undefined });
}
