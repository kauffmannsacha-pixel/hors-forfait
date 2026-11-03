// État observable des serveurs MCP (léger : pas de dépendance au SDK MCP, pour l'UI).
import { create } from 'zustand';
import type { McpServerConfig } from './mcpConfig';

export type McpStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'error';

export interface McpToolView {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

export interface McpServerView {
  name: string;
  config: McpServerConfig;
  status: McpStatus;
  error?: string;
  tools: McpToolView[];
  serverInfo?: { name: string; version: string };
  instructions?: string;
  logs: string[];
  connectedAt?: number;
  retryAt?: number;
}

interface McpState {
  initialized: boolean;
  loading: boolean;
  enabled: boolean;
  desktopPath: string | null;
  desktopFound: boolean;
  warnings: string[];
  servers: Record<string, McpServerView>;
}

export const useMcp = create<McpState>(() => ({
  initialized: false, loading: false, enabled: true, desktopPath: null, desktopFound: false, warnings: [], servers: {},
}));

export const patchServer = (name: string, patch: Partial<McpServerView>) =>
  useMcp.setState(s => (s.servers[name] ? { servers: { ...s.servers, [name]: { ...s.servers[name], ...patch } } } : s));

export const MAX_LOG_LINES = 200;
export function appendLog(name: string, line: string) {
  useMcp.setState(s => {
    const cur = s.servers[name]; if (!cur) return s;
    const logs = [...cur.logs, line.length > 2000 ? line.slice(0, 2000) + '…' : line].slice(-MAX_LOG_LINES);
    return { servers: { ...s.servers, [name]: { ...cur, logs } } };
  });
}

export const STATUS_LABELS: Record<McpStatus, string> = {
  disabled: 'Désactivé', idle: 'En attente', connecting: 'Connexion…', connected: 'Connecté', error: 'Erreur',
};
