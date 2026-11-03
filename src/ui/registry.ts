// ─────────────────────────────────────────────────────────────
// REGISTRE CENTRAL — chaque module s'enregistre depuis son index.ts.
// Évite que plusieurs modules modifient les mêmes fichiers.
// ─────────────────────────────────────────────────────────────
import type { ComponentType } from 'react';
import type { AnyExtension, Editor, Range } from '@tiptap/core';
import type { Page, PageKind } from '../db/types';

/** Écran accessible depuis la sidebar (section Studio / Assistants / Outils). */
export interface ViewDef { id: string; label: string; icon: string; component: ComponentType; section: 'studio' | 'assistants' | 'outils'; order?: number }
/** Rendu spécial d'une page selon son kind (database, script, studio…). Reçoit la page. */
export interface PageRenderer { kind: PageKind; component: ComponentType<{ page: Page }>; /** true = remplace l'éditeur ; false = affiché au-dessus */ replaceEditor?: boolean }
/** Élément du menu « / » de l'éditeur. */
export interface SlashItem { id: string; title: string; description?: string; icon: string; group: string; keywords?: string[]; run: (ctx: { editor: Editor; range: Range }) => void }
/** Commande de la palette Ctrl+K. */
export interface Command { id: string; title: string; icon?: string; group?: string; shortcut?: string; run: () => void }
/** Panneau dans Réglages. */
export interface SettingsPanel { id: string; label: string; icon: string; component: ComponentType; order?: number }
/** Outil exposé à Claude (format Anthropic tool use). destructive => confirmation obligatoire. */
export interface ClaudeTool {
  name: string; description: string; input_schema: Record<string, unknown>;
  destructive?: boolean; external?: boolean; // external = action vers un service externe (confirmation aussi)
  run: (input: Record<string, unknown>) => Promise<unknown>;
}
/** Panneau latéral droit (Claude, aperçu fichier, etc.). */
export interface SidePanelDef { id: string; title: string; component: ComponentType<{ props?: Record<string, unknown> }> }

export const views: ViewDef[] = [];
export const pageRenderers: PageRenderer[] = [];
export const editorExtensions: AnyExtension[] = [];
export const slashItems: SlashItem[] = [];
export const commands: Command[] = [];
export const settingsPanels: SettingsPanel[] = [];
export const claudeTools: ClaudeTool[] = [];
export const sidePanels: SidePanelDef[] = [];

const add = <T extends { id?: string; name?: string }>(arr: T[], item: T, key: 'id' | 'name' = 'id') => {
  if (!arr.find(x => x[key] === item[key])) arr.push(item);
};
export const registerView = (v: ViewDef) => add(views, v);
export const registerPageRenderer = (r: PageRenderer) => { if (!pageRenderers.find(x => x.kind === r.kind)) pageRenderers.push(r); };
export const registerEditorExtension = (...e: AnyExtension[]) => { for (const x of e) if (!editorExtensions.find(y => y.name === x.name)) editorExtensions.push(x); };
export const registerSlashItem = (...s: SlashItem[]) => s.forEach(x => add(slashItems, x));
export const registerCommand = (...c: Command[]) => c.forEach(x => add(commands, x));
export const registerSettingsPanel = (p: SettingsPanel) => add(settingsPanels, p);
export const registerClaudeTool = (...t: ClaudeTool[]) => t.forEach(x => add(claudeTools, x, 'name'));
export const registerSidePanel = (p: SidePanelDef) => add(sidePanels, p);
