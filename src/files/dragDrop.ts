// Glisser-déposer de fichiers depuis l'explorateur :
// - Tauri : getCurrentWebview().onDragDropEvent (chemins + position en pixels physiques) ;
// - navigateur / dépôt HTML5 hors éditeur : événements drop du DOM (File → importBytes).
// Indicateur du point d'insertion pendant le survol, Alt (ou réglage) = lier au lieu de copier.
import type { Editor } from '@tiptap/core';
import { create } from 'zustand';
import { isTauri } from '../db/store';
import { getActiveEditor } from '../editor/active';
import { FILE_PIN_NODE } from './api';
import { backend, domKeys } from './backend';
import { baseName, fileKind, plural, type FileKind } from './kinds';
import { resolvePinPosition, pinJobsAt } from './insert';
import { importJobs, type PinJob } from './jobs';
import { importBytes, importPath, pastedName } from './service';
import { useVault } from './store';

export type DropTarget =
  | { kind: 'editor'; editor: Editor; pos: number }
  | { kind: 'cursor'; editor: Editor; pos: number }
  | { kind: 'vault' }
  | { kind: 'ignore' };

export interface Caret { left: number; top: number; height: number; width?: number; horizontal?: boolean }
interface DropUi {
  active: boolean;
  x: number; y: number;
  caret: Caret | null;
  target: DropTarget['kind'];
  count: number;
  kinds: FileKind[];
  firstName: string;
  /** null = sans objet (dépôt HTML5 : copie uniquement). */
  link: boolean | null;
  /** Survol de la vue Fichiers (zone d'import). */
  overVault: boolean;
}
export const useDropUi = create<DropUi>(() => ({ active: false, x: 0, y: 0, caret: null, target: 'vault', count: 0, kinds: [], firstName: '', link: null, overVault: false }));

type PMElement = HTMLElement & { editor?: Editor };
const usable = (ed: Editor | undefined | null): ed is Editor =>
  !!ed && !ed.isDestroyed && ed.isEditable && !!ed.schema.nodes[FILE_PIN_NODE] && ed.view.dom.isConnected;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Que se passe-t-il si on dépose au point (x, y) en pixels CSS ? */
export function resolveDropTarget(x: number, y: number): DropTarget {
  const el = document.elementFromPoint(x, y);
  if (el?.closest('[data-files-drop="ignore"]')) return { kind: 'ignore' };
  if (el?.closest('[data-files-dropzone]')) return { kind: 'vault' };
  const ed = (el?.closest('.ProseMirror') as PMElement | null)?.editor;
  if (usable(ed)) {
    const r = ed.view.posAtCoords({ left: x, top: y });
    if (r) return { kind: 'editor', editor: ed, pos: r.pos };
  }
  const act = getActiveEditor()?.editor;
  if (usable(act)) {
    // Marges de la page : on vise la ligne la plus proche.
    const rect = act.view.dom.getBoundingClientRect();
    if (x >= rect.left - 160 && x <= rect.right + 160 && y >= rect.top - 24 && y <= rect.bottom + 160) {
      const r = act.view.posAtCoords({ left: clamp(x, rect.left + 2, rect.right - 2), top: clamp(y, rect.top + 2, rect.bottom - 2) });
      if (r) return { kind: 'editor', editor: act, pos: r.pos };
    }
    return { kind: 'cursor', editor: act, pos: act.state.selection.to };
  }
  return { kind: 'vault' };
}

/** Coordonnées (CSS) du point d'insertion : barre verticale dans le texte, horizontale entre deux blocs. */
export function caretFor(editor: Editor, pos: number): Caret | null {
  try {
    const { view, state } = editor;
    const t = resolvePinPosition(state, pos);
    if (t.newParagraphAt != null) {
      const c = view.coordsAtPos(t.newParagraphAt, -1);
      const r = view.dom.getBoundingClientRect();
      return { left: r.left + 8, top: c.bottom + 2, height: 2, width: Math.max(40, r.width - 16), horizontal: true };
    }
    const c = view.coordsAtPos(t.pos);
    return { left: c.left, top: c.top, height: Math.max(14, c.bottom - c.top) };
  } catch { return null; }
}

// ───────────── Jobs d'import ─────────────
export const pathJob = (path: string, link: boolean): PinJob => ({ name: baseName(path), run: onProgress => importPath(path, { link, onProgress }) });
export const fileJob = (file: File, pasted = false): PinJob => {
  const name = pasted ? pastedName(file.name, file.type) : file.name;
  return {
    name,
    run: async onProgress => {
      onProgress(0, file.size);
      const f = await importBytes(name, file.type, new Uint8Array(await file.arrayBuffer()));
      onProgress(file.size, file.size);
      return f;
    },
  };
};

/** Exécute un dépôt selon la cible. */
export function dropJobs(target: DropTarget, jobs: PinJob[]) {
  if (!jobs.length || target.kind === 'ignore') return;
  if (target.kind === 'vault') { importJobs(jobs); return; }
  pinJobsAt(target.editor, target.pos, jobs);
}

// ───────────── Défilement automatique pendant un glisser natif ─────────────
const scrollParent = (el: Element | null): HTMLElement | null => {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
};
let scrollRaf = 0; let scrollAt = { x: 0, y: 0 };
function autoScroll() {
  cancelAnimationFrame(scrollRaf);
  if (!useDropUi.getState().active) return;
  const box = scrollParent(document.elementFromPoint(scrollAt.x, scrollAt.y));
  if (!box) return;
  const r = box.getBoundingClientRect(); const edge = 56;
  const dy = scrollAt.y < r.top + edge ? -(r.top + edge - scrollAt.y) : scrollAt.y > r.bottom - edge ? scrollAt.y - (r.bottom - edge) : 0;
  if (!dy) return;
  box.scrollTop += Math.sign(dy) * Math.min(24, Math.abs(dy) / 2.5);
  scrollRaf = requestAnimationFrame(() => { refreshIndicator(); autoScroll(); });
}

// ───────────── Indicateur ─────────────
let pending = { x: 0, y: 0 };
let raf = 0;
function refreshIndicator() {
  const { x, y } = pending;
  const target = resolveDropTarget(x, y);
  const caret = target.kind === 'editor' ? caretFor(target.editor, target.pos) : null;
  const overVault = target.kind === 'vault' && !!document.elementFromPoint(x, y)?.closest('[data-files-dropzone]');
  useDropUi.setState({ active: true, x, y, caret, target: target.kind, overVault });
}
function moveIndicator(x: number, y: number) {
  pending = { x, y }; scrollAt = { x, y };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { refreshIndicator(); autoScroll(); });
}
export function hideIndicator() {
  cancelAnimationFrame(raf); cancelAnimationFrame(scrollRaf);
  useDropUi.setState({ active: false, caret: null, overVault: false });
}
const describe = (names: string[]) => ({ count: names.length, kinds: names.slice(0, 3).map(n => fileKind(n)), firstName: names[0] ?? '' });

// ───────────── Tauri : dépôt natif ─────────────
let nativeActive = false;
let nativeUntil = 0;
/** Un glisser natif Tauri est en cours (le dépôt HTML5 éventuel doit être ignoré). */
export const isNativeDragActive = () => nativeActive || Date.now() < nativeUntil;

let altSample = { alt: false, at: 0 };
let polling = false;
async function pollAlt() {
  if (polling || Date.now() - altSample.at < 100) return;
  polling = true;
  try {
    const k = await backend.keyState();
    altSample = { alt: k.alt, at: Date.now() };
    const link = k.alt !== useVault.getState().linkByDefault;
    if (useDropUi.getState().link !== link) useDropUi.setState({ link });
  } finally { polling = false; }
}

export async function setupNativeDrop(): Promise<void> {
  if (!isTauri) return;
  const w = window as unknown as { __prismeFilesDnd?: boolean };
  if (w.__prismeFilesDnd) return; // pas de double écoute (rechargement à chaud)
  w.__prismeFilesDnd = true;
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const toCss = (p: { x: number; y: number }) => { const r = window.devicePixelRatio || 1; return { x: p.x / r, y: p.y / r }; };
  await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    if (payload.type === 'enter') {
      nativeActive = true;
      useDropUi.setState({ ...describe(payload.paths.map(baseName)), link: useVault.getState().linkByDefault });
      const { x, y } = toCss(payload.position);
      moveIndicator(x, y); pollAlt();
    } else if (payload.type === 'over') {
      const { x, y } = toCss(payload.position);
      moveIndicator(x, y); pollAlt();
    } else if (payload.type === 'drop') {
      nativeActive = false; nativeUntil = Date.now() + 600;
      const { x, y } = toCss(payload.position);
      const target = resolveDropTarget(x, y);
      const k = await backend.keyState();
      const alt = k.alt || (altSample.alt && Date.now() - altSample.at < 400);
      const link = alt !== useVault.getState().linkByDefault;
      hideIndicator();
      dropJobs(target, payload.paths.map(p => pathJob(p, link)));
    } else {
      nativeActive = false;
      hideIndicator();
    }
  });
}

// ───────────── Navigateur : dépôt HTML5 hors éditeur ─────────────
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

export function setupDomDrop() {
  const w = window as unknown as { __prismeFilesDomDnd?: boolean };
  if (w.__prismeFilesDomDnd) return;
  w.__prismeFilesDomDnd = true;
  window.addEventListener('dragover', e => {
    if (!hasFiles(e) || isNativeDragActive()) return;
    e.preventDefault(); // autorise le dépôt (sinon le navigateur ouvrirait le fichier)
    clearTimeout(leaveTimer);
    const ui = useDropUi.getState();
    if (!ui.active) useDropUi.setState({ count: e.dataTransfer?.items.length ?? 0, kinds: [], firstName: '', link: null });
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    moveIndicator(e.clientX, e.clientY);
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    // dragleave est émis à chaque changement d'élément : on attend d'être vraiment sorti.
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(hideIndicator, 120);
  });
  window.addEventListener('drop', e => {
    hideIndicator();
    if (!hasFiles(e) || e.defaultPrevented) return; // déjà traité (éditeur, vue Fichiers)
    e.preventDefault();
    if (isNativeDragActive()) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    dropJobs(resolveDropTarget(e.clientX, e.clientY), files.map(f => fileJob(f)));
  });
  window.addEventListener('dragend', hideIndicator);
}

/** Texte du badge de dépôt. */
export function dropLabel(ui: Pick<DropUi, 'target' | 'count' | 'firstName' | 'link'>): { title: string; sub: string } {
  const what = ui.count === 1 && ui.firstName ? `« ${ui.firstName} »` : ui.count ? plural(ui.count, 'fichier') : 'les fichiers';
  const title = ui.target === 'editor' ? `Épingler ${what} ici`
    : ui.target === 'cursor' ? `Épingler ${what} au curseur`
    : ui.target === 'ignore' ? 'Dépôt géré par ce panneau'
    : `Ajouter ${what} au vault`;
  const linkDefault = useVault.getState().linkByDefault;
  const sub = ui.link === null ? 'Copie dans le vault'
    : ui.link ? `Lien vers l'original · ${linkDefault ? 'Alt pour copier' : 'relâche Alt pour copier'}`
    : `Copie dans le vault · ${linkDefault ? 'relâche Alt pour lier' : 'Alt pour lier'}`;
  return { title, sub };
}
export const currentDomKeys = domKeys;
