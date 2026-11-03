// Client MCP de Prisme : réutilise les serveurs de Claude Desktop (claude_desktop_config.json)
// + les serveurs ajoutés dans Prisme. Transport stdio via Rust, HTTP « streamable » (repli SSE).
// Implémente le contrat src/claude/mcpApi.ts (setMcpImpl dans index.ts).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { repo, isTauri } from '../db/store';
import { secrets } from '../db/secrets';
import { httpFetch } from '../db/http';
import type { McpToolInfo } from './mcpApi';
import {
  KV_DISABLED_DESKTOP, KV_MCP_ENABLED, KV_PRISME_SERVERS, mergeServers, parseDesktopConfig, prismeServerConfig, secretKeyFor,
  type HttpServerConfig, type McpServerConfig, type McpTransportKind, type PrismeServerSecrets, type StoredPrismeServer,
} from './mcpConfig';
import { appendLog, patchServer, useMcp, type McpServerView, type McpToolView } from './mcpStore';
import { TauriStdioTransport, errorText, tauriBackend } from './mcpTransport';

const CLIENT_INFO = { name: 'Prisme', version: '0.1.0' };
const STDIO_CONNECT_TIMEOUT = 90_000;   // npx/uvx peuvent télécharger le paquet au premier lancement
const HTTP_CONNECT_TIMEOUT = 30_000;
const LIST_TIMEOUT = 30_000;
const CALL_TIMEOUT = 120_000;
const CALL_MAX_TOTAL = 10 * 60_000;
const RETRY_DELAYS = [3_000, 15_000, 60_000];

interface Conn { client: Client; transport: Transport; gen: number; closing: boolean }
const conns = new Map<string, Conn>();
const pending = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const attempts = new Map<string, number>();
let gen = 0;
let initPromise: Promise<void> | null = null;
let settledPromise: Promise<void> | null = null;

const mcpFetch = (url: string | URL, init?: RequestInit) => httpFetch(url, init);

// ───────────────────────────── Configuration ─────────────────────────────

async function readStored(): Promise<StoredPrismeServer[]> {
  return ((await repo.kvGet<StoredPrismeServer[]>(KV_PRISME_SERVERS)) ?? []).filter(s => s && typeof s.name === 'string');
}
async function readSecrets(name: string): Promise<PrismeServerSecrets | null> {
  try { const raw = await secrets.get(secretKeyFor(name)); return raw ? (JSON.parse(raw) as PrismeServerSecrets) : null; } catch { return null; }
}

async function loadConfig(): Promise<McpServerConfig[]> {
  let desktopText: string | null = null; let desktopPath: string | null = null; const warnings: string[] = [];
  if (isTauri) {
    try { desktopText = await tauriBackend.invoke<string | null>('mcp_read_desktop_config', {}); } catch (e) { warnings.push(errorText(e)); }
    try { desktopPath = await tauriBackend.invoke<string | null>('mcp_desktop_config_path', {}); } catch { /* facultatif */ }
  }
  const desk = parseDesktopConfig(desktopText);
  warnings.push(...desk.warnings);
  const stored = await readStored();
  const prisme = await Promise.all(stored.map(async s => prismeServerConfig(s, await readSecrets(s.name))));
  const disabled = (await repo.kvGet<string[]>(KV_DISABLED_DESKTOP)) ?? [];
  const enabled = (await repo.kvGet<boolean>(KV_MCP_ENABLED)) ?? true;
  useMcp.setState({ desktopPath, desktopFound: desktopText != null, warnings, enabled });
  return mergeServers(desk.servers, prisme, disabled);
}

function viewFor(cfg: McpServerConfig, prev?: McpServerView): McpServerView {
  return { name: cfg.name, config: cfg, status: cfg.enabled ? 'idle' : 'disabled', tools: [], logs: prev?.logs ?? [] };
}

// ───────────────────────────── Cycle de vie ─────────────────────────────

/** Lance le client MCP (une seule fois) : lit la configuration et connecte les serveurs actifs. */
export function initMcp(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      useMcp.setState({ loading: true });
      // Processus restés d'une session précédente du webview (rechargement) : on repart propre.
      if (isTauri) await tauriBackend.invoke('mcp_kill_all', {}).catch(() => undefined);
      const configs = await loadConfig();
      const prev = useMcp.getState().servers;
      useMcp.setState({ servers: Object.fromEntries(configs.map(c => [c.name, viewFor(c, prev[c.name])])), initialized: true, loading: false });
      settledPromise = connectAllEnabled();
    })().catch(e => { useMcp.setState({ loading: false, initialized: true, warnings: [errorText(e)] }); });
  }
  return initPromise;
}

function connectAllEnabled(): Promise<void> {
  const st = useMcp.getState();
  if (!st.enabled) return Promise.resolve();
  const names = Object.values(st.servers).filter(s => s.config.enabled).map(s => s.name);
  return Promise.allSettled(names.map(n => connectServer(n))).then(() => undefined);
}

/** Attend la fin des premières tentatives de connexion (au plus `maxMs`). */
async function waitSettled(maxMs = 15_000) {
  await initMcp();
  if (settledPromise) await Promise.race([settledPromise, new Promise(r => setTimeout(r, maxMs))]);
}

/** Relit les configurations et reconnecte tout. */
export async function reloadMcp(): Promise<void> {
  if (!initPromise) { await initMcp(); return; }
  await initPromise;
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear(); attempts.clear();
  await Promise.allSettled([...conns.keys()].map(n => closeConn(n)));
  if (isTauri) await tauriBackend.invoke('mcp_kill_all', {}).catch(() => undefined);
  useMcp.setState({ loading: true });
  const configs = await loadConfig();
  const prev = useMcp.getState().servers;
  useMcp.setState({ servers: Object.fromEntries(configs.map(c => [c.name, viewFor(c, prev[c.name])])), loading: false });
  settledPromise = connectAllEnabled();
  await settledPromise;
}

async function closeConn(name: string) {
  const c = conns.get(name);
  if (!c) return;
  c.closing = true;
  conns.delete(name);
  try { await c.client.close(); } catch { /* déjà fermé */ }
}

/** Connecte (ou reconnecte) un serveur. Les appels concurrents partagent la même tentative. */
export function connectServer(name: string, manual = false): Promise<void> {
  if (manual) { attempts.set(name, 0); const t = retryTimers.get(name); if (t) clearTimeout(t); retryTimers.delete(name); }
  const cur = pending.get(name);
  if (cur) return cur;
  const p = doConnect(name).finally(() => pending.delete(name));
  pending.set(name, p);
  return p;
}

function lastStderr(name: string, n = 3): string {
  const logs = useMcp.getState().servers[name]?.logs ?? [];
  return logs.filter(l => !l.startsWith('[')).slice(-n).join(' · ');
}

async function doConnect(name: string): Promise<void> {
  const view = useMcp.getState().servers[name];
  if (!view) throw new Error(`Serveur MCP « ${name} » introuvable.`);
  const cfg = view.config;
  await closeConn(name);
  patchServer(name, { status: 'connecting', error: undefined, retryAt: undefined });
  const myGen = ++gen;
  try {
    const { client, transport } = cfg.transport === 'stdio' ? await connectStdio(cfg) : await connectHttp(cfg);
    const tools = await fetchAllTools(client);
    if (!useMcp.getState().servers[name]?.config.enabled || !useMcp.getState().enabled) {
      // Désactivé pendant la connexion.
      try { await client.close(); } catch { /* ignore */ }
      patchServer(name, { status: 'disabled', tools: [] });
      return;
    }
    const conn: Conn = { client, transport, gen: myGen, closing: false };
    conns.set(name, conn);
    client.onclose = () => handleClosed(name, myGen);
    client.onerror = (e) => appendLog(name, `[erreur] ${e.message}`);
    const info = client.getServerVersion();
    patchServer(name, {
      status: 'connected', tools: tools.map(toToolView), error: undefined, connectedAt: Date.now(),
      serverInfo: info ? { name: info.name, version: info.version } : undefined, instructions: client.getInstructions(),
    });
    attempts.set(name, 0);
    appendLog(name, `[prisme] connecté — ${tools.length} outil${tools.length > 1 ? 's' : ''}`);
  } catch (e) {
    const msg = humanizeMcpError(e, name, cfg);
    appendLog(name, `[prisme] échec : ${msg}`);
    patchServer(name, { status: 'error', error: msg, tools: [] });
    scheduleRetry(name);
    throw new Error(msg);
  }

  async function connectStdio(c: Extract<McpServerConfig, { transport: 'stdio' }>) {
    if (!isTauri) throw new Error('Les serveurs MCP locaux (stdio) ne fonctionnent que dans l\'application Prisme.');
    const client = newClient(name);
    const t = new TauriStdioTransport({ server: name, command: c.command, args: c.args, env: c.env });
    t.onlog = (line) => appendLog(name, line);
    try {
      await client.connect(t, { timeout: STDIO_CONNECT_TIMEOUT });
    } catch (e) {
      try { await t.close(); } catch { /* ignore */ }
      if (t.exitCode != null) throw new Error(`le processus s'est arrêté au démarrage (code ${t.exitCode})`);
      throw e;
    }
    return { client, transport: t as Transport };
  }
}

function newClient(name: string): Client {
  return new Client(CLIENT_INFO, {
    capabilities: {},
    listChanged: {
      tools: {
        onChanged: (error, tools) => {
          if (error) { appendLog(name, `[prisme] liste d'outils : ${error.message}`); return; }
          if (tools) patchServer(name, { tools: tools.map(toToolView) });
        },
      },
    },
  });
}

async function connectHttp(cfg: HttpServerConfig): Promise<{ client: Client; transport: Transport }> {
  const url = new URL(cfg.url);
  const requestInit: RequestInit = { headers: cfg.headers };
  if (cfg.transport === 'sse') {
    const client = newClient(cfg.name);
    // Les en-têtes de requestInit sont aussi appliqués à la connexion EventSource par le SDK.
    const t = new SSEClientTransport(url, { requestInit, fetch: mcpFetch });
    await client.connect(t, { timeout: HTTP_CONNECT_TIMEOUT });
    return { client, transport: t };
  }
  const client = newClient(cfg.name);
  try {
    const t = new StreamableHTTPClientTransport(url, { requestInit, fetch: mcpFetch, reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 3 } });
    await client.connect(t, { timeout: HTTP_CONNECT_TIMEOUT });
    return { client, transport: t };
  } catch (e) {
    // Compatibilité avec les anciens serveurs « HTTP + SSE » (protocole 2024-11-05).
    const code = e instanceof StreamableHTTPError ? e.code : undefined;
    if (code === 404 || code === 405 || code === 400) {
      try { await client.close(); } catch { /* ignore */ }
      const legacy = newClient(cfg.name);
      const t = new SSEClientTransport(url, { requestInit, fetch: mcpFetch });
      await legacy.connect(t, { timeout: HTTP_CONNECT_TIMEOUT });
      return { client: legacy, transport: t };
    }
    throw e;
  }
}

async function fetchAllTools(client: Client): Promise<Tool[]> {
  if (!client.getServerCapabilities()?.tools) return [];
  const out: Tool[] = []; let cursor: string | undefined;
  do {
    const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT });
    out.push(...r.tools);
    cursor = r.nextCursor;
  } while (cursor && out.length < 5000);
  return out;
}

function toToolView(t: Tool): McpToolView {
  const ann = t.annotations ?? {};
  const readOnly = ann.readOnlyHint === true;
  return {
    name: t.name, title: t.title ?? ann.title, description: t.description,
    inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    readOnly, destructive: !readOnly && ann.destructiveHint !== false,
  };
}

function handleClosed(name: string, connGen: number) {
  const c = conns.get(name);
  if (!c || c.gen !== connGen || c.closing) return;
  conns.delete(name);
  const tail = lastStderr(name);
  patchServer(name, { status: 'error', tools: [], error: `Le serveur s'est arrêté${tail ? ' — ' + tail : ''}.` });
  appendLog(name, '[prisme] connexion perdue');
  scheduleRetry(name);
}

function scheduleRetry(name: string) {
  const st = useMcp.getState();
  const view = st.servers[name];
  if (!st.enabled || !view?.config.enabled) return;
  const n = (attempts.get(name) ?? 0) + 1;
  attempts.set(name, n);
  if (n > RETRY_DELAYS.length) {
    patchServer(name, { retryAt: undefined, error: (view.error ?? 'Erreur') + ' (reconnexion automatique abandonnée — utilise « Reconnecter »)' });
    return;
  }
  const delay = RETRY_DELAYS[n - 1];
  const old = retryTimers.get(name); if (old) clearTimeout(old);
  patchServer(name, { retryAt: Date.now() + delay });
  retryTimers.set(name, setTimeout(() => {
    retryTimers.delete(name);
    const v = useMcp.getState().servers[name];
    if (v?.config.enabled && useMcp.getState().enabled && v.status !== 'connected') connectServer(name).catch(() => undefined);
  }, delay));
}

/** Déconnecte un serveur (sans le désactiver). */
export async function disconnectServer(name: string) {
  const t = retryTimers.get(name); if (t) clearTimeout(t);
  retryTimers.delete(name);
  await closeConn(name);
  const v = useMcp.getState().servers[name];
  if (v) patchServer(name, { status: v.config.enabled ? 'idle' : 'disabled', tools: [], retryAt: undefined });
}

// ───────────────────────────── Réglages ─────────────────────────────

/** Active / désactive un serveur (Claude Desktop : liste kv 'mcp:disabled' ; Prisme : kv 'mcp:servers'). */
export async function setServerEnabled(name: string, enabled: boolean) {
  const v = useMcp.getState().servers[name]; if (!v) return;
  if (v.config.source === 'prisme') {
    const list = await readStored();
    await repo.kvSet(KV_PRISME_SERVERS, list.map(s => (s.name === name ? { ...s, enabled } : s)));
  } else {
    const disabled = new Set((await repo.kvGet<string[]>(KV_DISABLED_DESKTOP)) ?? []);
    if (enabled) disabled.delete(name); else disabled.add(name);
    await repo.kvSet(KV_DISABLED_DESKTOP, [...disabled]);
  }
  patchServer(name, { config: { ...v.config, enabled } as McpServerConfig, status: enabled ? 'idle' : 'disabled', error: undefined });
  if (enabled) { if (useMcp.getState().enabled) await connectServer(name, true).catch(() => undefined); }
  else await disconnectServer(name);
}

/** Active / désactive tout le client MCP. */
export async function setMcpEnabled(enabled: boolean) {
  await repo.kvSet(KV_MCP_ENABLED, enabled);
  useMcp.setState({ enabled });
  if (!enabled) { for (const n of Object.keys(useMcp.getState().servers)) await disconnectServer(n); }
  else { attempts.clear(); settledPromise = connectAllEnabled(); await settledPromise; }
}

export interface NewServerInput {
  name: string; transport: McpTransportKind;
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
}

/** Ajoute (ou remplace, si `replace` vaut le nom actuel) un serveur Prisme. */
export async function savePrismeServer(input: NewServerInput, replace?: string): Promise<void> {
  await initMcp();
  const name = input.name.trim();
  const list = (await readStored()).filter(s => s.name !== replace);
  if (replace && replace !== name) {
    await closeConn(replace);
    await secrets.del(secretKeyFor(replace)).catch(() => undefined);
    useMcp.setState(s => { const servers = { ...s.servers }; delete servers[replace]; return { servers }; });
  }
  const env = input.transport === 'stdio' ? (input.env ?? {}) : {};
  const headers = input.transport === 'stdio' ? {} : (input.headers ?? {});
  const stored: StoredPrismeServer = {
    name, transport: input.transport, enabled: true, addedAt: Date.now(),
    ...(input.transport === 'stdio' ? { command: input.command?.trim(), args: input.args ?? [] } : { url: input.url?.trim() }),
    envKeys: Object.keys(env), headerKeys: Object.keys(headers),
  };
  await repo.kvSet(KV_PRISME_SERVERS, [...list.filter(s => s.name !== name), stored]);
  if (Object.keys(env).length || Object.keys(headers).length) await secrets.set(secretKeyFor(name), JSON.stringify({ env, headers }));
  else await secrets.del(secretKeyFor(name)).catch(() => undefined);
  const cfg = prismeServerConfig(stored, { env, headers });
  const prev = useMcp.getState().servers[name];
  useMcp.setState(s => ({ servers: { ...s.servers, [name]: viewFor(cfg, prev) } }));
  attempts.set(name, 0);
  if (useMcp.getState().enabled) await connectServer(name, true).catch(() => undefined);
}

/** Configuration d'un serveur Prisme avec ses valeurs sensibles (pour le formulaire de modification). */
export async function getPrismeServer(name: string): Promise<McpServerConfig | null> {
  const s = (await readStored()).find(x => x.name === name);
  return s ? prismeServerConfig(s, await readSecrets(name)) : null;
}

export async function removePrismeServer(name: string): Promise<void> {
  await disconnectServer(name);
  await repo.kvSet(KV_PRISME_SERVERS, (await readStored()).filter(s => s.name !== name));
  await secrets.del(secretKeyFor(name)).catch(() => undefined);
  useMcp.setState(s => { const servers = { ...s.servers }; delete servers[name]; return { servers }; });
}

// ───────────────────────────── Outils (contrat) ─────────────────────────────

/** Outils de tous les serveurs connectés (attend les premières connexions, 15 s max). */
export async function listTools(): Promise<McpToolInfo[]> {
  await waitSettled();
  return connectedTools().map(({ server, tool }) => ({ server, name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/** Outils disponibles immédiatement (sans attendre), pour la boucle d'outils de Claude. */
export function connectedTools(): { server: string; tool: McpToolView }[] {
  const out: { server: string; tool: McpToolView }[] = [];
  for (const v of Object.values(useMcp.getState().servers)) if (v.status === 'connected') for (const t of v.tools) out.push({ server: v.name, tool: t });
  return out;
}

export interface McpCallOutput {
  text: string;
  raw: unknown;
  isError?: boolean;
  images: { mediaType: string; base64: string }[];
}

/** Appelle un outil MCP. Connecte le serveur au besoin (s'il est actif). */
export async function callToolRich(server: string, tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; onProgress?: (p: { progress: number; total?: number; message?: string }) => void } = {}): Promise<McpCallOutput> {
  await initMcp();
  const v = useMcp.getState().servers[server];
  if (!v) throw new Error(`Serveur MCP « ${server} » introuvable.`);
  if (!useMcp.getState().enabled) throw new Error('Le client MCP est désactivé (Réglages → Claude).');
  if (!v.config.enabled) throw new Error(`Le serveur MCP « ${server} » est désactivé (Réglages → Claude).`);
  if (!conns.has(server)) {
    if (pending.has(server)) await pending.get(server);
    else await connectServer(server, true);
  }
  const c = conns.get(server);
  if (!c) throw new Error(`Le serveur MCP « ${server} » n'est pas connecté.`);
  try {
    const res = await c.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT, resetTimeoutOnProgress: true, maxTotalTimeout: CALL_MAX_TOTAL, signal: opts.signal,
      onprogress: opts.onProgress ? (p) => opts.onProgress!({ progress: p.progress, total: p.total, message: p.message }) : undefined,
    });
    return summarizeCallResult(res);
  } catch (e) {
    throw new Error(humanizeMcpError(e, server, v.config));
  }
}

/** Contrat mcpApi.callTool. */
export async function callTool(server: string, tool: string, args: Record<string, unknown>) {
  const r = await callToolRich(server, tool, args);
  return { text: r.text, raw: r.raw, isError: r.isError };
}

/** Convertit un CallToolResult MCP en texte (+ images à transmettre à Claude). */
export function summarizeCallResult(res: unknown): McpCallOutput {
  const r = (res ?? {}) as { content?: unknown[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };
  const parts: string[] = []; const images: McpCallOutput['images'] = [];
  for (const item of Array.isArray(r.content) ? r.content : []) {
    const it = item as Record<string, unknown>;
    switch (it.type) {
      case 'text': parts.push(String(it.text ?? '')); break;
      case 'image':
        if (typeof it.data === 'string' && typeof it.mimeType === 'string') images.push({ mediaType: it.mimeType, base64: it.data });
        parts.push(`[image ${String(it.mimeType ?? '')}]`);
        break;
      case 'audio': parts.push(`[audio ${String(it.mimeType ?? '')} — non transmis]`); break;
      case 'resource_link': parts.push(`[ressource : ${String(it.name ?? it.uri ?? '')}${it.uri ? ' — ' + String(it.uri) : ''}]`); break;
      case 'resource': {
        const rs = (it.resource ?? {}) as Record<string, unknown>;
        if (typeof rs.text === 'string') parts.push(rs.text);
        else parts.push(`[ressource binaire : ${String(rs.uri ?? '')} (${String(rs.mimeType ?? 'type inconnu')})]`);
        break;
      }
      default: parts.push(JSON.stringify(it));
    }
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  if (!parts.length && r.toolResult !== undefined) parts.push(typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult, null, 2));
  return { text: parts.join('\n\n'), raw: res, isError: r.isError === true, images };
}

// ───────────────────────────── Erreurs ─────────────────────────────

export function humanizeMcpError(e: unknown, name: string, cfg?: McpServerConfig): string {
  const where = `Serveur « ${name} »`;
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout) return `${where} : pas de réponse (délai dépassé).`;
    if (e.code === ErrorCode.ConnectionClosed) { const tail = lastStderr(name); return `${where} : connexion fermée${tail ? ' — ' + tail : ''}.`; }
    if (e.code === ErrorCode.MethodNotFound) return `${where} : fonction non prise en charge par le serveur.`;
    if (e.code === ErrorCode.InvalidParams) return `${where} : paramètres invalides — ${stripMcpPrefix(e.message)}`;
    return `${where} : ${stripMcpPrefix(e.message)}`;
  }
  if (e instanceof UnauthorizedError) return `${where} : authentification requise — ajoute l'en-tête « Authorization » dans Réglages → Claude.`;
  if (e instanceof StreamableHTTPError || e instanceof SseError) {
    const code = e.code;
    if (code === 401 || code === 403) return `${where} : accès refusé (${code}) — vérifie l'en-tête d'authentification dans Réglages → Claude.`;
    if (code === 404) return `${where} : adresse introuvable (404).`;
    if (code && code >= 500) return `${where} : erreur du serveur (${code}).`;
    return `${where} : ${e.message}`;
  }
  if (e instanceof Error && (e.name === 'AbortError' || /aborted|cancel/i.test(e.message))) return 'Appel MCP annulé.';
  const msg = errorText(e);
  if (cfg && cfg.transport !== 'stdio' && /fetch|network|connect|dns|refused|sending request|url not allowed/i.test(msg)) return `${where} : impossible de joindre ${cfg.url}.`;
  if (/^(Impossible|Le |La |Les |Connexion|Serveur|Écriture|Commande)/.test(msg)) return `${where} : ${msg.charAt(0).toLowerCase()}${msg.slice(1)}`;
  return `${where} : ${msg || 'erreur inconnue'}`;
}
const stripMcpPrefix = (m: string) => m.replace(/^MCP error -?\d+:\s*/i, '');

/** Pour les tests et le débogage. */
export const __internal = { conns, pending, attempts };
