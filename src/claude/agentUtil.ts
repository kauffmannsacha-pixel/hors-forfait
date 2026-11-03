// Aides pures de la boucle d'outils : validation des entrées, confirmation, mise en forme des résultats.
import type Anthropic from '@anthropic-ai/sdk';

type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface ToolMeta { name: string; source: 'prisme' | 'module' | 'mcp'; server?: string; originalName?: string; readOnly?: boolean; destructive?: boolean; external?: boolean }

/** Une confirmation est obligatoire pour toute action destructive ou externe (MCP non lecture seule compris). */
export const needsConfirmation = (t: ToolMeta) => !!t.destructive || !!t.external || (t.source === 'mcp' && !t.readOnly);

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** Validation légère d'une entrée d'outil contre son schéma JSON (type objet, champs requis, types et enum de premier niveau). */
export function validateToolInput(input: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'l\'entrée doit être un objet JSON' };
  const obj = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [];
  const missing = required.filter(k => obj[k] === undefined);
  if (missing.length) return { ok: false, error: `champ(s) requis manquant(s) : ${missing.join(', ')}` };
  const props = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(obj)) {
    const def = props[k];
    if (!def || v === undefined) continue;
    const declared = def.type;
    const types = Array.isArray(declared) ? declared.map(String) : typeof declared === 'string' ? [declared] : [];
    if (types.length) {
      const actual = typeOf(v);
      const ok = types.some(t => t === actual || (t === 'number' && actual === 'integer') || (t === 'integer' && actual === 'number' && Number.isInteger(v)));
      if (!ok) return { ok: false, error: `« ${k} » devrait être de type ${types.join(' ou ')} (reçu : ${actual})` };
    }
    if (Array.isArray(def.enum) && !def.enum.some(e => e === v)) return { ok: false, error: `« ${k} » doit valoir ${def.enum.map(e => JSON.stringify(e)).join(', ')}` };
  }
  return { ok: true };
}

/** Schéma d'entrée sûr pour l'API (type objet obligatoire). */
export function normalizeInputSchema(schema: unknown): Anthropic.Beta.BetaTool.InputSchema {
  const s = (schema && typeof schema === 'object' ? schema : {}) as Record<string, unknown>;
  if (s.type === 'object') return s as Anthropic.Beta.BetaTool.InputSchema;
  return { ...s, type: 'object', properties: (s.properties as Record<string, unknown>) ?? {} };
}

const shortValue = (v: unknown): string => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  const one = (t ?? '').replace(/\s+/g, ' ').trim();
  return one.length > 140 ? one.slice(0, 140) + '…' : one;
};

/** Paramètres d'un appel, en liste lisible (« • clé : valeur »). */
export function formatParams(input: Record<string, unknown>, max = 8): string {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (!entries.length) return '(aucun paramètre)';
  const lines = entries.slice(0, max).map(([k, v]) => `• ${k} : ${shortValue(v)}`);
  if (entries.length > max) lines.push(`• … (${entries.length - max} autre${entries.length - max > 1 ? 's' : ''})`);
  return lines.join('\n');
}

/** Message de la demande de confirmation. `summary` = résumé fourni par l'outil (outils internes). */
export function confirmationMessage(t: ToolMeta, input: Record<string, unknown>, summary?: string | null): string {
  const who = t.source === 'mcp'
    ? `Claude veut utiliser l'outil « ${t.originalName ?? t.name} » du serveur MCP « ${t.server} »`
    : t.source === 'module' ? `Claude veut utiliser l'outil « ${t.name} »` : 'Claude veut effectuer une action dans Prisme';
  const nature = t.destructive ? ' (action destructive)' : t.external || t.source === 'mcp' ? ' (action externe)' : '';
  return `${who}${nature}.\n\n${summary ? summary + '\n\n' : ''}Paramètres :\n${formatParams(input)}\n\nAutoriser ?`;
}

export const MAX_RESULT_CHARS = 100_000;

/** Coupe un résultat d'outil trop long en le signalant. */
export function clipResult(text: string, max = MAX_RESULT_CHARS): string {
  return text.length <= max ? text : text.slice(0, max) + `\n\n[… résultat tronqué : ${text.length.toLocaleString('fr-FR')} caractères au total]`;
}

/** Valeur de retour quelconque → texte pour Claude. */
export function stringifyResult(v: unknown): string {
  if (v === undefined || v === null) return 'OK';
  if (typeof v === 'string') return v || 'OK';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Bloc tool_result (texte + images éventuelles). */
export function toolResultBlock(id: string, text: string, opts: { isError?: boolean; images?: { mediaType: string; base64: string }[] } = {}): ToolResult {
  const imgs = (opts.images ?? []).filter(i => IMAGE_TYPES.has(i.mediaType) && i.base64.length < 7_000_000).slice(0, 5);
  const body = clipResult(text || (opts.isError ? 'Erreur' : 'OK'));
  if (!imgs.length) return { type: 'tool_result', tool_use_id: id, content: body, ...(opts.isError ? { is_error: true } : {}) };
  return {
    type: 'tool_result', tool_use_id: id, ...(opts.isError ? { is_error: true } : {}),
    content: [
      { type: 'text', text: body },
      ...imgs.map(i => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.base64 } })),
    ],
  };
}

/** Résultat d'erreur « entrée invalide » (format recommandé : JSON avec la clé INVALID_JSON). */
export function invalidInputResult(id: string, input: unknown, reason: string): ToolResult {
  return { type: 'tool_result', tool_use_id: id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input ?? null), erreur: reason }) };
}

export const DENIED_TEXT = 'L\'utilisateur a refusé cette action. Ne la retente pas sans son accord explicite ; propose une alternative si besoin.';
export const INTERRUPTED_TEXT = 'Interrompu par l\'utilisateur avant l\'exécution.';
