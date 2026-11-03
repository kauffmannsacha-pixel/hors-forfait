// Génération d'images via une API compatible « OpenAI Images » (POST {base}/images/generations).
// Réglages : kv 'images.settings' ; clé : coffre (secrets 'images_api_key'), jamais en clair.
import { httpFetch } from '../../../db/http';
import { secrets } from '../../../db/secrets';
import { repo } from '../../../db/store';
import { b64ToBytes } from './raster';

export const IMAGE_KEY_SECRET = 'images_api_key';
const KV_SETTINGS = 'images.settings';

export interface ImageApiSettings {
  preset: 'openai' | 'custom';
  baseUrl: string;            // ex. https://api.openai.com/v1
  model: string;              // ex. gpt-image-1
  size: string;               // ex. 1536x1024 (le résultat est recadré en 16:9 dans l'éditeur)
  quality: string;            // 'auto' = paramètre non envoyé
  responseFormat: 'auto' | 'b64_json' | 'url';
  extraJson: string;          // paramètres supplémentaires (JSON) pour les fournisseurs compatibles
}
export const DEFAULT_IMAGE_SETTINGS: ImageApiSettings = { preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', size: '1536x1024', quality: 'auto', responseFormat: 'auto', extraJson: '' };
export const PRESETS: Record<ImageApiSettings['preset'], { label: string; settings: Partial<ImageApiSettings> }> = {
  openai: { label: 'OpenAI', settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', size: '1536x1024', responseFormat: 'auto' } },
  custom: { label: 'Autre fournisseur compatible OpenAI', settings: {} },
};

export async function getImageSettings(): Promise<ImageApiSettings> {
  try { return { ...DEFAULT_IMAGE_SETTINGS, ...((await repo.kvGet<Partial<ImageApiSettings>>(KV_SETTINGS)) ?? {}) }; }
  catch { return { ...DEFAULT_IMAGE_SETTINGS }; }
}
export const saveImageSettings = (s: ImageApiSettings) => repo.kvSet(KV_SETTINGS, s);
export const hasImageKey = async () => { try { return !!(await secrets.get(IMAGE_KEY_SECRET)); } catch { return false; } };
export async function isImageApiConfigured(): Promise<boolean> {
  const s = await getImageSettings();
  return !!(s.baseUrl && s.model && (await hasImageKey()));
}

/** Vérifie et normalise l'URL de base (HTTPS obligatoire, sauf serveur local). */
export function normalizeBaseUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(s); } catch { throw new Error('URL de base invalide (ex. https://api.openai.com/v1).'); }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('L\'URL de base doit être en HTTPS (HTTP accepté seulement pour un serveur local).');
  return s;
}
export function parseExtra(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try { const o = JSON.parse(json); if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>; } catch { /* ci-dessous */ }
  throw new Error('Paramètres supplémentaires : JSON objet invalide.');
}

async function errorOf(r: Response): Promise<Error> {
  let msg = '';
  try { const j = await r.json() as { error?: { message?: string } | string; message?: string }; msg = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? ''; } catch { /* corps non JSON */ }
  const map: Record<number, string> = { 400: 'requête refusée', 401: 'clé API refusée', 403: 'accès interdit (organisation non vérifiée ou modèle non autorisé)', 404: 'point d\'accès ou modèle introuvable', 429: 'quota ou limite de débit atteint', 500: 'erreur du fournisseur', 503: 'fournisseur indisponible' };
  if (/safety|moderation|content[_ ]policy/i.test(msg)) return new Error('Génération d\'image refusée par la modération du fournisseur : reformule le concept.');
  return new Error(`API d'images : ${map[r.status] ?? 'erreur ' + r.status}${msg ? ' — ' + msg.slice(0, 240) : ''}`);
}

/** Test de connexion : GET {base}/models (sans coût). */
export async function testImageApi(override?: Partial<ImageApiSettings>): Promise<{ ok: boolean; message: string }> {
  const s = { ...(await getImageSettings()), ...override };
  const key = await secrets.get(IMAGE_KEY_SECRET);
  if (!key) return { ok: false, message: 'Aucune clé enregistrée.' };
  let base: string;
  try { base = normalizeBaseUrl(s.baseUrl); } catch (e) { return { ok: false, message: (e as Error).message }; }
  let r: Response;
  try { r = await httpFetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } }); }
  catch (e) { return { ok: false, message: `Fournisseur injoignable : ${(e as Error).message}` }; }
  if (r.status === 404 || r.status === 405) return { ok: true, message: 'Fournisseur joint, mais il ne liste pas ses modèles : la clé sera vérifiée à la première génération.' };
  if (!r.ok) return { ok: false, message: (await errorOf(r)).message };
  try {
    const j = await r.json() as { data?: { id: string }[] };
    const ids = (j.data ?? []).map(m => m.id);
    if (!ids.length) return { ok: true, message: 'Connexion réussie.' };
    return ids.includes(s.model)
      ? { ok: true, message: `Connexion réussie : le modèle « ${s.model} » est disponible.` }
      : { ok: false, message: `Clé valide, mais le modèle « ${s.model} » n'apparaît pas parmi les ${ids.length} modèles du compte.` };
  } catch { return { ok: true, message: 'Connexion réussie.' }; }
}

export interface GeneratedImage { bytes: Uint8Array; mime: string; revisedPrompt?: string }
/** Génère une image (1 résultat). */
export async function generateImage(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<GeneratedImage> {
  const s = await getImageSettings();
  const key = await secrets.get(IMAGE_KEY_SECRET);
  if (!key) throw new Error('Aucune API d\'images configurée — Réglages → Images.');
  const base = normalizeBaseUrl(s.baseUrl);
  const body: Record<string, unknown> = { model: s.model, prompt: prompt.slice(0, 3800), n: 1, ...(s.size ? { size: s.size } : {}), ...(s.quality && s.quality !== 'auto' ? { quality: s.quality } : {}), ...(s.responseFormat !== 'auto' ? { response_format: s.responseFormat } : {}), ...parseExtra(s.extraJson) };
  const r = await httpFetch(`${base}/images/generations`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal });
  if (!r.ok) throw await errorOf(r);
  const j = await r.json() as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[]; output_format?: string };
  const d = j.data?.[0];
  if (!d) throw new Error('API d\'images : réponse vide.');
  if (d.b64_json) {
    const fmt = (j.output_format ?? 'png').toLowerCase();
    return { bytes: b64ToBytes(d.b64_json), mime: fmt === 'jpeg' || fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png', revisedPrompt: d.revised_prompt };
  }
  if (d.url) {
    const img = await httpFetch(d.url, { signal: opts.signal });
    if (!img.ok) throw await errorOf(img);
    const blob = await img.blob();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/png', revisedPrompt: d.revised_prompt };
  }
  throw new Error('API d\'images : aucune image dans la réponse.');
}
