// Transport MCP stdio via Rust (Tauri) : implémente l'interface Transport du SDK MCP.
//   start  → écoute « mcp-message » / « mcp-log » / « mcp-exit » puis invoque mcp_spawn
//   send   → mcp_send (une ligne JSON par message)
//   close  → mcp_kill
// Le « backend » (invoke/listen) est injectable pour les tests.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

export interface StdioBackend {
  invoke<T = unknown>(cmd: string, args: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}

/** Backend réel : commandes et événements Tauri. */
export const tauriBackend: StdioBackend = {
  async invoke<T>(cmd: string, args: Record<string, unknown>) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  },
  async listen<T>(event: string, cb: (payload: T) => void) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, e => cb(e.payload));
  },
};

export interface StdioLaunch {
  server: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

let seq = 0;
const nextId = (server: string) => `${server}#${Date.now().toString(36)}${(++seq).toString(36)}`;

export class TauriStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Lignes de journal (stderr, ou stdout non JSON). */
  onlog?: (line: string, stream: 'stderr' | 'stdout') => void;

  readonly procId: string;
  pid: number | null = null;
  exitCode: number | null = null;
  private unlisten: (() => void)[] = [];
  private started = false;
  private closed = false;

  constructor(private launch: StdioLaunch, private backend: StdioBackend = tauriBackend) {
    this.procId = nextId(launch.server);
  }

  get isClosed() { return this.closed; }

  async start(): Promise<void> {
    if (this.started) throw new Error('Transport MCP déjà démarré.');
    this.started = true;
    const id = this.procId;
    // Écoute AVANT le lancement pour ne perdre aucune ligne.
    this.unlisten.push(await this.backend.listen<{ id: string; line: string }>('mcp-message', p => { if (p.id === id) this.handleLine(p.line); }));
    this.unlisten.push(await this.backend.listen<{ id: string; line: string }>('mcp-log', p => { if (p.id === id) this.onlog?.(p.line, 'stderr'); }));
    this.unlisten.push(await this.backend.listen<{ id: string; code: number | null }>('mcp-exit', p => { if (p.id === id) this.handleExit(p.code); }));
    try {
      const pid = await this.backend.invoke<number>('mcp_spawn', { id, command: this.launch.command, args: this.launch.args, env: this.launch.env });
      this.pid = typeof pid === 'number' ? pid : null;
    } catch (e) {
      this.dispose();
      this.closed = true;
      throw new Error(errorText(e) || `Impossible de lancer le serveur « ${this.launch.server} ».`);
    }
  }

  private handleLine(line: string) {
    const t = line.trim();
    if (!t) return;
    if (!t.startsWith('{') && !t.startsWith('[')) { this.onlog?.(t, 'stdout'); return; }
    let msg: JSONRPCMessage;
    try { msg = deserializeMessage(t); } catch (e) {
      this.onlog?.(t, 'stdout');
      this.onerror?.(new Error(`Message MCP illisible : ${(e as Error).message.slice(0, 200)}`));
      return;
    }
    this.onmessage?.(msg);
  }

  private handleExit(code: number | null) {
    this.exitCode = code;
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error(`Connexion au serveur MCP « ${this.launch.server} » fermée.`);
    try {
      await this.backend.invoke('mcp_send', { id: this.procId, line: JSON.stringify(message) });
    } catch (e) {
      throw new Error(errorText(e) || `Envoi impossible au serveur « ${this.launch.server} ».`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    try { await this.backend.invoke('mcp_kill', { id: this.procId }); } catch { /* déjà arrêté */ }
    this.onclose?.();
  }

  private dispose() {
    for (const u of this.unlisten.splice(0)) { try { u(); } catch { /* ignore */ } }
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : e ? JSON.stringify(e) : '');
