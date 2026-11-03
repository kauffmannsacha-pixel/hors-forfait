// Implémentation du contrat `files` (src/files/api.ts) + actions de la vue Fichiers.
import type { ID, Page, VaultFile } from '../db/types';
import { repo } from '../db/store';
import { usePages } from '../db/pages';
import { confirmAction, openSidePanel, openView, toast, toastAction } from '../ui/appState';
import { backend, errMsg, type Picked, type Progress } from './backend';
import {
  applyChange, applyCheck, linkedAt, mergeImport, relocateEntry, removeEntry, watchPaths,
  type VaultChange, type VaultEntry,
} from './indexLogic';
import { baseName, plural } from './kinds';
import { loadVault, updateIndex, useVault } from './store';
import { usagesOf, type Usage } from './usages';
import { create } from 'zustand';

let readyP: Promise<void> | null = null;
/** Index chargé + backend prêt (URL blob préchargées en mode navigateur). */
export const ready = () => (readyP ??= Promise.all([loadVault(), backend.init()]).then(() => undefined));

/** Préférences partagées de la vue Fichiers (ex. ouverture filtrée sur les introuvables). */
export const useFilesViewPrefs = create<{ state: 'all' | 'linked' | 'copied' | 'missing' | 'unused' }>(() => ({ state: 'all' }));

function commit(raw: VaultEntry): VaultEntry {
  const { index, entry, orphanCopy } = mergeImport(useVault.getState().files, raw);
  useVault.setState({ files: index });
  if (orphanCopy) backend.remove({ ...raw, path: orphanCopy, linked: false }).catch(() => {});
  if (entry.linked) syncWatch();
  return entry;
}

/** Importe un fichier du disque (copie dédupliquée, ou lien) avec suivi de progression. */
export async function importPath(path: string, opts: { link?: boolean; onProgress?: Progress } = {}): Promise<VaultEntry> {
  await ready();
  return commit(await backend.importPath(path, !!opts.link, opts.onProgress));
}

/** Nom lisible pour une capture collée (« image.png » générique du presse-papiers). */
export function pastedName(name: string, mime: string, now = new Date()): string {
  const generic = !name || /^(image|blob|clipboard|unknown)(\.\w+)?$/i.test(name);
  if (!generic) return name;
  const ext = (name.match(/\.(\w+)$/)?.[1] ?? mime.split('/')[1]?.split('+')[0] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
  const p = (n: number) => String(n).padStart(2, '0');
  return `Capture ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`;
}

export async function importBytes(name: string, mime: string, bytes: Uint8Array): Promise<VaultEntry> {
  await ready();
  return commit(await backend.importBytes(name, mime, bytes));
}

/** Importe un élément choisi (chemin en Tauri, File dans le navigateur). */
export async function importPicked(p: Picked, link: boolean, onProgress?: Progress): Promise<VaultEntry> {
  if ('path' in p) return importPath(p.path, { link, onProgress });
  onProgress?.(0, p.file.size);
  const bytes = new Uint8Array(await p.file.arrayBuffer());
  const f = await importBytes(p.file.name, p.file.type, bytes);
  onProgress?.(p.file.size, p.file.size);
  return f;
}
export const pickedName = (p: Picked) => ('path' in p ? baseName(p.path) : p.file.name);

export async function get(hash: string): Promise<VaultEntry | undefined> { await ready(); return useVault.getState().files[hash]; }
export async function list(): Promise<VaultEntry[]> { await ready(); return Object.values(useVault.getState().files).sort((a, b) => b.addedAt - a.addedAt); }

async function pagesMap(): Promise<Record<ID, Page>> {
  const st = usePages.getState();
  if (st.loaded) return st.pages;
  return Object.fromEntries((await repo.listPages()).map(p => [p.id, p]));
}
/** Usages détaillés (corbeille comprise). */
export async function usagesDetailed(hash: string): Promise<Usage[]> { return usagesOf(hash, await pagesMap()); }
/** Contrat : pages (hors corbeille) où le fichier est épinglé. */
export async function usages(hash: string) {
  return (await usagesDetailed(hash)).filter(u => !u.trashed).map(u => ({ pageId: u.pageId, title: u.title }));
}

export function url(file: VaultFile): string { return backend.url(file); }

export async function open(hash: string, where: 'panel' | 'system' = 'panel'): Promise<void> {
  const f = await get(hash);
  if (!f) throw new Error('Ce fichier ne fait plus partie du vault.');
  if (where === 'panel') { openSidePanel('file', { hash }); return; }
  if (f.missing) {
    toast(`« ${f.name} » est introuvable (déplacé ou supprimé). Relocalise-le depuis le panneau d'aperçu.`, 'warning');
    openSidePanel('file', { hash });
    return;
  }
  await backend.openSystem(f);
}

export async function reveal(hash: string): Promise<void> {
  const f = await get(hash);
  if (!f) throw new Error('Ce fichier ne fait plus partie du vault.');
  if (f.missing) throw new Error(`« ${f.name} » est introuvable à son emplacement d'origine.`);
  await backend.reveal(f);
}

/** Exécute une action en affichant l'erreur éventuelle dans un toast. */
export function attempt(fn: () => Promise<unknown>) { fn().catch(e => toast(errMsg(e), 'error')); }

// ───────────── Relocaliser / supprimer ─────────────
const parentDir = (p: string) => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : undefined; };

/** Choisit le nouvel emplacement d'un fichier introuvable et vérifie son empreinte SHA-256. */
export async function relocate(hash: string): Promise<boolean> {
  await ready();
  const f = useVault.getState().files[hash];
  if (!f) throw new Error('Ce fichier ne fait plus partie du vault.');
  if (backend.mode !== 'tauri') throw new Error("La relocalisation nécessite l'application de bureau.");
  const picked = await backend.pick({ multiple: false, title: `Où se trouve « ${f.name} » ?`, defaultPath: parentDir(f.path) });
  const first = picked[0];
  if (!first || !('path' in first)) return false;
  const probe = await backend.importPath(first.path, true); // empreinte seulement, aucune copie
  if (probe.hash !== f.hash) {
    if (!f.linked) throw new Error(`Ce n'est pas le même fichier : l'empreinte SHA-256 ne correspond pas à « ${f.name} ».`);
    const ok = await confirmAction(
      `Le contenu de « ${probe.name} » est différent de celui épinglé (empreinte SHA-256 différente : le fichier a peut-être été modifié). Lier quand même ce fichier à toutes les puces existantes ?`,
      { confirmLabel: 'Lier ce fichier' });
    if (!ok) return false;
  }
  if (f.linked) {
    updateIndex(ix => relocateEntry(ix, hash, probe.path, { size: probe.size, modifiedAt: probe.modifiedAt }));
    syncWatch();
  } else {
    // Copie perdue dans le vault : on la recrée à partir du fichier retrouvé.
    const copy = await backend.importPath(first.path, false);
    updateIndex(ix => relocateEntry(ix, hash, copy.path, { size: copy.size }));
  }
  toast(`« ${f.name} » a été relocalisé.`, 'success');
  return true;
}

/** Supprime un fichier du vault s'il n'est épinglé nulle part (copie effacée du disque ; un lien ne touche jamais l'original). */
export async function removeFromVault(hash: string): Promise<boolean> {
  await ready();
  const f = useVault.getState().files[hash];
  if (!f) return false;
  const used = await usagesDetailed(hash);
  if (used.length) {
    const inTrash = used.every(u => u.trashed);
    throw new Error(inTrash
      ? `« ${f.name} » est encore épinglé dans ${plural(used.length, 'page')} de la corbeille. Vide la corbeille d'abord.`
      : `« ${f.name} » est épinglé dans ${plural(used.length, 'page')} : retire d'abord ses puces.`);
  }
  const ok = await confirmAction(
    f.linked
      ? `Retirer « ${f.name} » du vault ? Le fichier d'origine n'est pas supprimé.`
      : `Supprimer « ${f.name} » du vault ? La copie (${f.path}) sera effacée du disque.`,
    { danger: true, confirmLabel: f.linked ? 'Retirer' : 'Supprimer' });
  if (!ok) return false;
  if (!f.linked && !f.missing) await backend.remove(f);
  updateIndex(ix => removeEntry(ix, hash));
  if (f.linked) syncWatch();
  toast(`« ${f.name} » a été retiré du vault.`, 'success');
  return true;
}

// ───────────── Surveillance des fichiers liés ─────────────
let watchTimer: ReturnType<typeof setTimeout> | undefined;
/** Met à jour la liste des fichiers liés surveillés par Rust (regroupé). */
export function syncWatch() {
  if (backend.mode !== 'tauri') return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    backend.watch(watchPaths(useVault.getState().files)).catch(e => console.warn('[fichiers] surveillance :', e));
  }, 250);
}

function announceMissing(missing: VaultEntry[]) {
  if (!missing.length) return;
  if (missing.length === 1) {
    const f = missing[0];
    toastAction(`Fichier ${f.linked ? 'lié ' : ''}introuvable : « ${f.name} » a été déplacé ou supprimé.`, 'Relocaliser', () => attempt(() => relocate(f.hash)), 'warning');
  } else {
    toastAction(`${plural(missing.length, 'fichier')} introuvables (déplacés ou supprimés).`, 'Voir', () => { useFilesViewPrefs.setState({ state: 'missing' }); openView('fichiers'); }, 'warning');
  }
}

/** Vérifie la présence de tous les fichiers (liés et copiés). */
export async function recheck(opts: { silent?: boolean } = {}): Promise<{ missing: number; restored: number }> {
  await ready();
  const entries = Object.values(useVault.getState().files);
  const paths = entries.map(e => e.path);
  const missingPaths = await backend.check(paths);
  const { index, newlyMissing, restored } = applyCheck(useVault.getState().files, paths, missingPaths);
  if (newlyMissing.length || restored.length) useVault.setState({ files: index });
  if (!opts.silent) announceMissing(newlyMissing);
  if (restored.length && !opts.silent) toast(`${plural(restored.length, 'fichier retrouvé', 'fichiers retrouvés')}.`, 'success');
  return { missing: missingPaths.length, restored: restored.length };
}

async function onChange(ev: VaultChange) {
  let change = ev;
  const hits = linkedAt(useVault.getState().files, ev.path);
  if (!hits.length) return;
  if (ev.kind === 'renamed' && ev.newPath && ev.guess) {
    // Déplacement déduit (même nom réapparu ailleurs) : on vérifie avant d'accepter.
    const f = hits[0];
    let same = ev.size === f.size;
    if (!same) { try { same = (await backend.importPath(ev.newPath, true)).hash === f.hash; } catch { same = false; } }
    if (!same) change = { path: ev.path, kind: 'removed' };
  }
  const { index, affected, restored } = applyChange(useVault.getState().files, change);
  useVault.setState({ files: index });
  if (change.kind === 'removed') announceMissing(affected);
  else if (change.kind === 'renamed') toast(`« ${affected[0]?.name} » a été déplacé — lien mis à jour.`, 'info');
  else if (restored.length) toast(`Fichier lié retrouvé : « ${restored[0].name} ».`, 'success');
  syncWatch();
}

let monitoring = false;
/** Au démarrage : vérification des fichiers + surveillance des liens (Tauri), revérification au retour sur l'app. */
export async function startMonitoring() {
  if (monitoring) return;
  monitoring = true;
  await ready();
  if (backend.mode === 'tauri') {
    backend.dir().then(dir => useVault.setState({ dir })).catch(() => {});
    await backend.onChanged(ev => { onChange(ev).catch(e => console.warn('[fichiers]', e)); });
    syncWatch();
  }
  await recheck().catch(e => console.warn('[fichiers] vérification :', e));
  let last = Date.now();
  window.addEventListener('focus', () => {
    if (Date.now() - last < 30_000) return;
    last = Date.now();
    recheck().catch(() => {});
  });
}
