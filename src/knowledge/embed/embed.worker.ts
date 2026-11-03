// Web Worker : embeddings locaux avec @huggingface/transformers (aucune donnée envoyée à un serveur).
// Le modèle est téléchargé depuis le Hub Hugging Face au premier usage puis gardé dans le cache du navigateur (Cache API).
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

type InMsg = { type: 'load'; id: number; model: string } | { type: 'embed'; id: number; model: string; texts: string[] };

interface WorkerScope { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<InMsg>) => void) | null }
const ctx = self as unknown as WorkerScope;

env.allowLocalModels = false;
env.useBrowserCache = true;

let current: { model: string; ready: Promise<FeatureExtractionPipeline> } | null = null;

function load(model: string): Promise<FeatureExtractionPipeline> {
  if (current && current.model === model) return current.ready;
  const ready = pipeline('feature-extraction', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (info: unknown) => ctx.postMessage({ type: 'progress', info }),
  }) as Promise<FeatureExtractionPipeline>;
  current = { model, ready };
  ready.catch(() => { if (current?.ready === ready) current = null; });
  return ready;
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model);
      ctx.postMessage({ type: 'ready', id: msg.id });
      return;
    }
    const extractor = await load(msg.model);
    const out = await extractor(msg.texts, { pooling: 'mean', normalize: true });
    const dims = out.dims as number[];
    const dim = dims[dims.length - 1];
    const data = Float32Array.from(out.data as ArrayLike<number>);
    ctx.postMessage({ type: 'result', id: msg.id, dim, count: msg.texts.length, buffer: data.buffer }, [data.buffer]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
