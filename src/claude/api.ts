// ─────────────────────────────────────────────────────────────
// CONTRAT Claude — utilisé par TOUS les modules (assistants, mail, connecteurs…).
// Le module claude peut l'étendre (MCP, outils) sans changer ces signatures.
// ─────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { secrets } from '../db/secrets';
import { repo } from '../db/store';
import { httpFetch } from '../db/http';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FAST_MODEL = 'claude-haiku-5-5';
export const getModel = async () => (await repo.kvGet<string>('claude.model')) ?? DEFAULT_MODEL;
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

/** Réponse texte (streaming si onText fourni). */
export async function askClaude(o: AskOptions): Promise<string> {
  const client = await getClient();
  const model = o.model ?? (o.fast ? FAST_MODEL : await getModel());
  const params = { model, max_tokens: o.maxTokens ?? 8000, system: o.system, messages: buildMessages(o) };
  try {
    if (o.onText) {
      let full = '';
      const stream = client.messages.stream(params, { signal: o.signal });
      stream.on('text', (d) => { full += d; o.onText!(d, full); });
      await stream.finalMessage();
      return full;
    }
    const res = await client.messages.create(params, { signal: o.signal });
    return res.content.map(b => (b.type === 'text' ? b.text : '')).join('');
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
  if (e instanceof Anthropic.APIError) {
    const m: Record<number, string> = { 401: 'clé API Anthropic invalide', 403: 'accès refusé par Anthropic', 429: 'limite de débit Anthropic atteinte, réessaie dans un instant', 529: 'Claude est surchargé, réessaie dans un instant' };
    return new Error('Claude : ' + (m[e.status ?? 0] ?? e.message));
  }
  if (e instanceof Error && e.name === 'AbortError') return new Error('Requête annulée.');
  return e instanceof Error ? e : new Error(String(e));
}
