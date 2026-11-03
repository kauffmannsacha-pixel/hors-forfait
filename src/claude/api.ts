// ─────────────────────────────────────────────────────────────
// CONTRAT Claude — utilisé par TOUS les modules (assistants, mail, connecteurs…).
// Le module claude peut l'étendre (MCP, outils) sans changer ces signatures.
// ─────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { secrets } from '../db/secrets';
import { repo } from '../db/store';
import { httpFetch } from '../db/http';
import { guessCaps, type Effort, type ModelCaps } from './modelCaps';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FAST_MODEL = 'claude-haiku-5-5';
/** Modèle choisi dans Réglages → Claude ; à défaut le plus récent Claude Opus détecté via l'API Models ; sinon DEFAULT_MODEL. */
export const getModel = async () =>
  (await repo.kvGet<string | null>('claude.model')) || (await repo.kvGet<string | null>('claude.model.auto')) || DEFAULT_MODEL;
export const setModel = (m: string) => repo.kvSet('claude.model', m);

export type ImageInput = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64: string } | { url: string };
export interface ChatMessage { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }
export interface AskOptions {
  system?: string;
  messages?: ChatMessage[];      // si absent : prompt seul
  prompt?: string;
  images?: ImageInput[];         // ajoutées au dernier message utilisateur (Claude Vision)
  model?: string;
  maxTokens?: number;
  fast?: boolean;                // modèle rapide (haiku) pour tâches légères
  onText?: (delta: string, full: string) => void; // streaming
  signal?: AbortSignal;
  /** Effort de réflexion (ignoré si le modèle ne le supporte pas). Défaut : celui du modèle. */
  effort?: Effort;
}

let cached: Anthropic | null = null;
export async function getClient(): Promise<Anthropic> {
  const key = await secrets.get('anthropic_api_key');
  if (!key) throw new Error('Clé API Anthropic manquante — ajoute-la dans Réglages → Claude.');
  if (!cached || cached.apiKey !== key) {
    cached = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, fetch: httpFetch as unknown as typeof fetch });
  }
  return cached;
}
export const resetClient = () => { cached = null; };

/** Capacités d'un modèle : cache de l'API Models (kv 'claude.models'), sinon déduction depuis l'identifiant. */
export async function getModelCaps(model: string): Promise<ModelCaps> {
  const cache = await repo.kvGet<{ fetchedAt: number; models: ModelCaps[] }>('claude.models').catch(() => undefined);
  return cache?.models?.find(m => m.id === model) ?? guessCaps(model);
}

function buildMessages(o: AskOptions): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = (o.messages ?? []).map(m => ({ role: m.role, content: m.content }));
  if (o.prompt) msgs.push({ role: 'user', content: o.prompt });
  if (o.images?.length) {
    const last = msgs[msgs.length - 1];
    const blocks: Anthropic.ContentBlockParam[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
    const imgs: Anthropic.ImageBlockParam[] = o.images.map(i => 'url' in i
      ? { type: 'image', source: { type: 'url', url: i.url } }
      : { type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.base64 } });
    last.content = [...imgs, ...blocks];
  }
  return msgs;
}

/** Erreur levée quand les garde-fous de Claude refusent la demande (stop_reason « refusal »). */
export class ClaudeRefusalError extends Error {
  constructor(public category: string | null) {
    super('Claude a refusé de répondre à cette demande' + (category ? ` (catégorie : ${category})` : '') + '. Reformule ta demande.');
    this.name = 'ClaudeRefusalError';
  }
}

/** Réponse texte (streaming si onText fourni). */
export async function askClaude(o: AskOptions): Promise<string> {
  const client = await getClient();
  const model = o.model ?? (o.fast ? FAST_MODEL : await getModel());
  const caps = await getModelCaps(model);
  const effort = o.effort && caps.efforts?.includes(o.effort) ? o.effort : undefined;
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: o.maxTokens ?? 8000,
    ...(o.system ? { system: o.system } : {}),
    messages: buildMessages(o) as unknown as Anthropic.Beta.BetaMessageParam[],
    ...(effort ? { output_config: { effort } } : {}),
    // Repli serveur si les garde-fous du modèle refusent la demande (modèles sans repli : sans effet).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  try {
    let message: Anthropic.Beta.BetaMessage;
    let full = '';
    if (o.onText) {
      const stream = client.beta.messages.stream(params, { signal: o.signal });
      stream.on('text', (d) => { full += d; o.onText!(d, full); });
      message = await stream.finalMessage();
    } else {
      message = await client.beta.messages.create(params, { signal: o.signal });
      full = message.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    }
    if (message.stop_reason === 'refusal') throw new ClaudeRefusalError(message.stop_details?.category ?? null);
    return full;
  } catch (e) { throw humanizeClaudeError(e); }
}

/** Réponse JSON typée : extrait le premier objet/tableau JSON de la réponse. */
export async function askClaudeJSON<T>(o: AskOptions): Promise<T> {
  const sys = (o.system ? o.system + '\n\n' : '') + 'Réponds UNIQUEMENT avec du JSON valide, sans texte autour ni balises markdown.';
  const txt = await askClaude({ ...o, system: sys, onText: undefined });
  return parseJSONLoose<T>(txt);
}
export function parseJSONLoose<T>(txt: string): T {
  const cleaned = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned) as T; } catch { /* continue */ }
  const start = cleaned.search(/[[{]/); const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
  throw new Error('Réponse de Claude illisible (JSON attendu).');
}
export function humanizeClaudeError(e: unknown): Error {
  if (e instanceof ClaudeRefusalError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('Requête annulée.'), { name: 'AbortError' });
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new Error('Claude : délai de réponse dépassé, réessaie dans un instant.');
  if (e instanceof Anthropic.APIConnectionError) return new Error('Claude : impossible de joindre l\'API Anthropic (vérifie ta connexion internet).');
  if (e instanceof Anthropic.APIError) {
    const m: Record<number, string> = {
      400: 'requête refusée par l\'API', 401: 'clé API Anthropic invalide', 403: 'accès refusé par Anthropic',
      404: 'modèle ou ressource introuvable (vérifie le modèle dans Réglages → Claude)', 413: 'requête trop volumineuse',
      429: 'limite de débit Anthropic atteinte, réessaie dans un instant', 500: 'erreur interne d\'Anthropic, réessaie dans un instant',
      529: 'Claude est surchargé, réessaie dans un instant',
    };
    const base = m[e.status ?? 0];
    const detail = apiErrorDetail(e);
    return new Error('Claude : ' + (base ? base + (detail && (e.status === 400 || e.status === 404 || e.status === 413) ? ' — ' + detail : '') : (detail || e.message)));
  }
  if (e instanceof Error && e.name === 'AbortError') return new Error('Requête annulée.');
  return e instanceof Error ? e : new Error(String(e));
}
function apiErrorDetail(e: InstanceType<typeof Anthropic.APIError>): string {
  const err = e.error as { error?: { message?: string } } | undefined;
  return (err?.error?.message ?? '').slice(0, 300);
}
/** true si l'erreur correspond à une annulation volontaire (bouton « Arrêter »). */
export const isAbortError = (e: unknown) =>
  e instanceof Anthropic.APIUserAbortError || (e instanceof Error && (e.name === 'AbortError' || e.message === 'Requête annulée.'));
