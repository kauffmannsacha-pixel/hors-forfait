// État global de navigation / UI (zustand).
import { create } from 'zustand';
import type { ID } from '../db/types';

export type Route = { type: 'page'; id: ID } | { type: 'view'; id: string } | { type: 'settings'; panel?: string };
export interface Toast { id: number; text: string; kind: 'info' | 'success' | 'warning' | 'error' }

interface AppState {
  route: Route;
  history: Route[];
  selectionText: string;                 // texte sélectionné dans l'éditeur courant
  sidePanel: { id: string; props?: Record<string, unknown> } | null;
  paletteOpen: boolean;
  theme: 'system' | 'light' | 'dark';
  toasts: Toast[];
}
export const useApp = create<AppState>(() => ({
  route: { type: 'view', id: 'studio' }, history: [], selectionText: '', sidePanel: null, paletteOpen: false, theme: 'system', toasts: [],
}));

export const navigate = (route: Route) => useApp.setState(s => ({ route, history: [...s.history.slice(-50), s.route] }));
export const openPage = (id: ID) => navigate({ type: 'page', id });
export const openView = (id: string) => navigate({ type: 'view', id });
export const goBack = () => useApp.setState(s => s.history.length ? { route: s.history[s.history.length - 1], history: s.history.slice(0, -1) } : s);
export const openSidePanel = (id: string, props?: Record<string, unknown>) => useApp.setState({ sidePanel: { id, props } });
export const closeSidePanel = () => useApp.setState({ sidePanel: null });
export const currentPageId = (): ID | null => { const r = useApp.getState().route; return r.type === 'page' ? r.id : null; };

let tid = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++tid;
  useApp.setState(s => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => useApp.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), kind === 'error' ? 7000 : 3500);
}
/** Confirmation obligatoire avant action destructive / externe. Remplaçable par une jolie feuille par le module UI. */
export let confirmAction: (message: string, opts?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean> =
  async (message) => window.confirm(message);
export const setConfirmImpl = (fn: typeof confirmAction) => { confirmAction = fn; };
