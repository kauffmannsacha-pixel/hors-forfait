// Configuration des serveurs MCP (pur, testable) :
//  - lecture de claude_desktop_config.json (Claude Desktop) : clé « mcpServers » {command,args,env} ou {url,headers,type}
//  - serveurs ajoutés dans Prisme (kv 'mcp:servers' ; les valeurs sensibles env/en-têtes vont dans le coffre)
//  - fusion, validation et aides de saisie (arguments, variables d'environnement, en-têtes).

export type McpSource = 'claude-desktop' | 'prisme';
export type McpTransportKind = 'stdio' | 'http' | 'sse';

interface BaseServer { name: string; source: McpSource; enabled: boolean }
export interface StdioServerConfig extends BaseServer { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
export interface HttpServerConfig extends BaseServer { transport: 'http' | 'sse'; url: string; headers: Record<string, string> }
export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/** Serveur ajouté dans Prisme, tel que stocké dans kv 'mcp:servers' (sans valeurs secrètes). */
export interface StoredPrismeServer {
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** noms des variables d'environnement / en-têtes dont les valeurs sont dans le coffre */
  envKeys?: string[];
  headerKeys?: string[];
  addedAt: number;
}
/** Valeurs sensibles d'un serveur Prisme (coffre, clé `mcp_server:<nom>`). */
export interface PrismeServerSecrets { env?: Record<string, string>; headers?: Record<string, string> }

export const KV_PRISME_SERVERS = 'mcp:servers';
export const KV_DISABLED_DESKTOP = 'mcp:disabled';
export const KV_MCP_ENABLED = 'mcp:enabled';
export const secretKeyFor = (name: string) => `mcp_server:${name}`;

export interface DesktopParseResult { servers: McpServerConfig[]; warnings: string[] }

/** JSON tolérant : BOM, commentaires // et /* *\/, virgules finales. */
export function parseJsonLenient(text: string): unknown {
  const src = text.replace(/^﻿/, '');
  try { return JSON.parse(src); } catch { /* version tolérante ci-dessous */ }
  let out = ''; let i = 0; let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const toStringRecord = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null) out[k] = String(x);
  return out;
};

function transportOf(entry: Record<string, unknown>): McpTransportKind | null {
  const t = String(entry.type ?? entry.transport ?? '').toLowerCase();
  if (typeof entry.url === 'string' || typeof entry.serverUrl === 'string') {
    if (t === 'sse') return 'sse';
    return 'http';
  }
  if (typeof entry.command === 'string') return 'stdio';
  return null;
}

/** Analyse le texte de claude_desktop_config.json. */
export function parseDesktopConfig(text: string | null | undefined): DesktopParseResult {
  const warnings: string[] = [];
  if (!text || !text.trim()) return { servers: [], warnings };
  let json: unknown;
  try { json = parseJsonLenient(text); } catch (e) {
    return { servers: [], warnings: [`Configuration Claude Desktop illisible (JSON invalide) : ${(e as Error).message}`] };
  }
  if (!isRecord(json)) return { servers: [], warnings: ['Configuration Claude Desktop inattendue (objet JSON attendu).'] };
  const raw = json.mcpServers;
  if (raw === undefined) return { servers: [], warnings };
  if (!isRecord(raw)) return { servers: [], warnings: ['« mcpServers » devrait être un objet.'] };
  const servers: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) { warnings.push(`Serveur « ${name} » ignoré : configuration invalide.`); continue; }
    const kind = transportOf(value);
    const enabled = value.disabled !== true && value.enabled !== false;
    if (kind === 'stdio') {
      const command = String(value.command).trim();
      if (!command) { warnings.push(`Serveur « ${name} » ignoré : commande vide.`); continue; }
      const args = Array.isArray(value.args) ? value.args.map(a => String(a)) : typeof value.args === 'string' ? splitArgs(value.args) : [];
      servers.push({ name, source: 'claude-desktop', enabled, transport: 'stdio', command, args, env: toStringRecord(value.env) });
    } else if (kind === 'http' || kind === 'sse') {
      const url = String(value.url ?? value.serverUrl).trim();
      if (!/^https?:\/\//i.test(url)) { warnings.push(`Serveur « ${name} » ignoré : URL invalide.`); continue; }
      servers.push({ name, source: 'claude-desktop', enabled, transport: kind, url, headers: toStringRecord(value.headers) });
    } else {
      warnings.push(`Serveur « ${name} » ignoré : ni « command » ni « url ».`);
    }
  }
  return { servers, warnings };
}

/** Reconstitue la configuration complète d'un serveur Prisme (valeurs sensibles comprises). */
export function prismeServerConfig(s: StoredPrismeServer, sec: PrismeServerSecrets | null | undefined): McpServerConfig {
  if (s.transport === 'stdio') {
    return { name: s.name, source: 'prisme', enabled: s.enabled, transport: 'stdio', command: s.command ?? '', args: s.args ?? [], env: { ...(sec?.env ?? {}) } };
  }
  return { name: s.name, source: 'prisme', enabled: s.enabled, transport: s.transport, url: s.url ?? '', headers: { ...(sec?.headers ?? {}) } };
}

/** Fusionne Claude Desktop + Prisme. En cas de doublon de nom, le serveur Prisme l'emporte. */
export function mergeServers(desktop: McpServerConfig[], prisme: McpServerConfig[], disabledDesktop: string[] = []): McpServerConfig[] {
  const names = new Set(prisme.map(s => s.name));
  const d = desktop.filter(s => !names.has(s.name)).map(s => (disabledDesktop.includes(s.name) ? { ...s, enabled: false } : s));
  return [...d, ...prisme].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}

/** Découpe une ligne d'arguments façon shell (guillemets simples/doubles, antislash). */
export function splitArgs(line: string): string[] {
  const out: string[] = []; let cur = ''; let quote: '"' | "'" | null = null; let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) { cur += line[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Lignes « CLE=valeur » (ou « Nom: valeur » pour les en-têtes) → objet. Lignes vides et # ignorées. */
export function parseKeyValueLines(text: string, sep: '=' | ':' = '='): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {}; const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = line.indexOf(sep);
    if (at <= 0) { errors.push(`Ligne ${i + 1} : « ${sep} » attendu (ex. ${sep === '=' ? 'API_KEY=…' : 'Authorization: Bearer …'}).`); return; }
    const k = line.slice(0, at).trim(); const v = line.slice(at + 1).trim();
    if (!k) { errors.push(`Ligne ${i + 1} : nom manquant.`); return; }
    values[k] = v;
  });
  return { values, errors };
}

export const formatKeyValueLines = (rec: Record<string, string>, sep: '=' | ':' = '=') =>
  Object.entries(rec).map(([k, v]) => (sep === '=' ? `${k}=${v}` : `${k}: ${v}`)).join('\n');

/** Valide le formulaire « Ajouter un serveur ». Renvoie la liste des erreurs (vide si OK). */
export function validateNewServer(input: { name: string; transport: McpTransportKind; command?: string; url?: string }, existing: string[]): string[] {
  const errors: string[] = [];
  const name = input.name.trim();
  if (!name) errors.push('Donne un nom au serveur.');
  else if (!/^[\p{L}\p{N}_.\- ]{1,48}$/u.test(name)) errors.push('Nom invalide : lettres, chiffres, espaces, « - », « _ » ou « . » (48 caractères max).');
  else if (existing.some(n => n.toLowerCase() === name.toLowerCase())) errors.push('Un serveur porte déjà ce nom.');
  if (input.transport === 'stdio') {
    if (!input.command?.trim()) errors.push('Indique la commande à lancer (ex. npx, uvx, node, python).');
  } else {
    const url = input.url?.trim() ?? '';
    if (!url) errors.push('Indique l\'URL du serveur.');
    else { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) errors.push('L\'URL doit commencer par http:// ou https://.'); } catch { errors.push('URL invalide.'); } }
  }
  return errors;
}

/** Résumé lisible d'une configuration (affichage dans les réglages). */
export function describeServer(s: McpServerConfig): string {
  if (s.transport === 'stdio') return [s.command, ...s.args.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
  return `${s.transport === 'sse' ? 'SSE' : 'HTTP'} · ${s.url}`;
}
