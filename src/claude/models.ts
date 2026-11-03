// Modèles Claude (API Models) et réglages associés : liste, cache des capacités, « plus récent Opus »,
// effort, test de la clé API.
import Anthropic from '@anthropic-ai/sdk';
import { repo } from '../db/store';
import { secrets } from '../db/secrets';
import { httpFetch } from '../db/http';
import { DEFAULT_MODEL, getClient, getModel, humanizeClaudeError, resetClient } from './api';
import { capsFromModelInfo, pickLatestOpus, type Effort, type ModelCaps } from './modelCaps';

export const KV_MODELS = 'claude.models';
export const KV_MODEL = 'claude.model';
export const KV_MODEL_AUTO = 'claude.model.auto';
export const KV_EFFORT = 'claude.effort';
export const SECRET_KEY = 'anthropic_api_key';
const REFRESH_MS = 24 * 3600_000;

export interface ModelsCache { fetchedAt: number; models: ModelCaps[] }

async function fetchModels(client: Anthropic): Promise<ModelCaps[]> {
  const out: ModelCaps[] = [];
  for await (const m of client.models.list({ limit: 100 })) out.push(capsFromModelInfo(m));
  return out;
}

/** Interroge l'API Models, met en cache les capacités et le plus récent Claude Opus. */
export async function refreshModels(): Promise<ModelsCache> {
  try {
    const client = await getClient();
    const models = (await fetchModels(client)).filter(m => m.lifecycle !== 'retired');
    const cache: ModelsCache = { fetchedAt: Date.now(), models };
    await repo.kvSet(KV_MODELS, cache);
    const latest = pickLatestOpus(models);
    if (latest) await repo.kvSet(KV_MODEL_AUTO, latest);
    return cache;
  } catch (e) { throw humanizeClaudeError(e); }
}

export async function getModelsCache(): Promise<ModelsCache | null> {
  return (await repo.kvGet<ModelsCache>(KV_MODELS)) ?? null;
}

/** Rafraîchit la liste au plus une fois par jour (si une clé est configurée). */
export async function refreshModelsIfStale(): Promise<void> {
  if (!(await secrets.get(SECRET_KEY))) return;
  const cache = await getModelsCache();
  if (cache && Date.now() - cache.fetchedAt < REFRESH_MS) return;
  await refreshModels().catch(() => undefined);
}

/** Modèle choisi explicitement (null = automatique : le plus récent Claude Opus). */
export const getChosenModel = async () => (await repo.kvGet<string | null>(KV_MODEL)) || null;
export async function setChosenModel(id: string | null) { await repo.kvSet(KV_MODEL, id); }
export const getAutoModel = async () => (await repo.kvGet<string | null>(KV_MODEL_AUTO)) || DEFAULT_MODEL;
export { getModel };

export async function getEffortSetting(): Promise<Effort | 'auto'> {
  const v = await repo.kvGet<string>(KV_EFFORT);
  return v === 'auto' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max' ? v : 'medium';
}
export const setEffortSetting = (e: Effort | 'auto') => repo.kvSet(KV_EFFORT, e);

/** Vérifie une clé API (sans l'enregistrer) : renvoie le nombre de modèles accessibles. */
export async function testApiKey(key: string): Promise<{ count: number; latestOpus: string | null }> {
  const client = new Anthropic({ apiKey: key.trim(), dangerouslyAllowBrowser: true, fetch: httpFetch as unknown as typeof fetch, maxRetries: 0, timeout: 20_000 });
  try {
    const models = await fetchModels(client);
    return { count: models.length, latestOpus: pickLatestOpus(models) };
  } catch (e) { throw humanizeClaudeError(e); }
}

export async function saveApiKey(key: string): Promise<void> {
  await secrets.set(SECRET_KEY, key.trim());
  resetClient();
}
export async function deleteApiKey(): Promise<void> {
  await secrets.del(SECRET_KEY);
  resetClient();
}
export const hasApiKey = async () => !!(await secrets.get(SECRET_KEY));

/** Masque une clé pour l'affichage : « sk-ant-…a1b2 ». */
export const maskKey = (k: string) => (k.length <= 12 ? '••••' : `${k.slice(0, 7)}…${k.slice(-4)}`);
