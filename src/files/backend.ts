// Accès bas niveau au vault : commandes Rust (Tauri) ou IndexedDB + URL blob (navigateur, dev/tests).
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { VaultFile } from '../db/types';
import { isTauri } from '../db/store';
import { guessMime } from './kinds';
import type { VaultChange, VaultEntry } from './indexLogic';

export type Progress = (done: number, total: number) => void;
export interface KeyState { alt: boolean; ctrl: boolean; shift: boolean; supported: boolean }
/** Élément choisi dans la boîte de dialogue : chemin (Tauri) ou File (navigateur). */
export type Picked = { path: string } | { file: File };

export interface Backend {
  readonly mode: 'tauri' | 'browser';
  init(): Promise<void>;
  importPath(path: string, link: boolean, onProgress?: Progress): Promise<VaultEntry>;
  importBytes(name: string, mime: string, bytes: Uint8Array): Promise<VaultEntry>;
  url(file: VaultFile): string;
  readText(file: VaultFile, maxBytes: number): Promise<string>;
  readBytes(file: VaultFile, offset: number, length: number): Promise<ArrayBuffer>;
  check(paths: string[]): Promise<string[]>;
  watch(paths: string[]): Promise<void>;
  remove(file: VaultFile): Promise<void>;
  openSystem(file: VaultFile): Promise<void>;
  reveal(file: VaultFile): Promise<void>;
  dir(): Promise<string | null>;
  keyState(): Promise<KeyState>;
  pick(opts: { multiple: boolean; title: string; defaultPath?: string }): Promise<Picked[]>;
  onChanged(cb: (ev: VaultChange) => void): Promise<() => void>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));
const asError = (e: unknown) => (e instanceof Error ? e : new Error(errMsg(e)));

// État clavier vu par le DOM (repli hors Windows et pour les dépôts HTML5).
const dom = { alt: false, ctrl: false, shift: false };
if (typeof window !== 'undefined') {
  const sync = (e: KeyboardEvent | DragEvent | MouseEvent) => { dom.alt = e.altKey; dom.ctrl = e.ctrlKey || e.metaKey; dom.shift = e.shiftKey; };
  window.addEventListener('keydown', sync, true);
  window.addEventListener('keyup', sync, true);
  window.addEventListener('dragover', sync, true);
  window.addEventListener('blur', () => { dom.alt = dom.ctrl = dom.shift = false; });
}
export const domKeys = () => ({ ...dom });

// ───────────────────────── Tauri ─────────────────────────
class TauriBackend implements Backend {
  readonly mode = 'tauri' as const;
  private progress = new Map<string, Progress>();
  private listening: Promise<void> | null = null;

  async init() {
    this.listening ??= import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ token: string; done: number; total: number }>('vault-import-progress', e => this.progress.get(e.payload.token)?.(e.payload.done, e.payload.total)).then(() => undefined));
    await this.listening;
  }
  async importPath(path: string, link: boolean, onProgress?: Progress) {
    const token = onProgress ? crypto.randomUUID() : undefined;
    if (token && onProgress) this.progress.set(token, onProgress);
    try { return await invoke<VaultEntry>('vault_import', { path, link, token }); }
    catch (e) { throw asError(e); }
    finally { if (token) this.progress.delete(token); }
  }
  async importBytes(name: string, mime: string, bytes: Uint8Array) {
    try {
      // Corps binaire brut (bien plus rapide qu'un tableau JSON) ; nom/MIME en en-têtes encodés.
      return await invoke<VaultEntry>('vault_import_bytes', bytes, { headers: { 'x-vault-name': encodeURIComponent(name), 'x-vault-mime': encodeURIComponent(mime) } });
    } catch (e) { throw asError(e); }
  }
  url(file: VaultFile) { return convertFileSrc(file.path); }
  async readText(file: VaultFile, maxBytes: number) {
    try { return await invoke<string>('vault_read_text', { path: file.path, maxBytes }); } catch (e) { throw asError(e); }
  }
  async readBytes(file: VaultFile, offset: number, length: number) {
    try { return await invoke<ArrayBuffer>('vault_read_bytes', { path: file.path, offset, length }); } catch (e) { throw asError(e); }
  }
  async check(paths: string[]) { return paths.length ? invoke<string[]>('vault_check', { paths }) : []; }
  async watch(paths: string[]) { await invoke('vault_watch', { paths }); }
  async remove(file: VaultFile) {
    if (file.linked) return; // jamais : un fichier lié appartient à l'utilisateur
    try { await invoke('vault_remove', { path: file.path }); } catch (e) { throw asError(e); }
  }
  async openSystem(file: VaultFile) {
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(file.path);
    } catch {
      // Repli : commande Rust (si la permission opener:allow-open-path n'est pas accordée).
      try { await invoke('vault_open', { path: file.path }); } catch (e) { throw new Error(`Impossible d'ouvrir « ${file.name} » : ${errMsg(e)}`); }
    }
  }
  async reveal(file: VaultFile) {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(file.path);
    } catch {
      try { await invoke('vault_reveal', { path: file.path }); } catch (e) { throw new Error(`Impossible d'afficher « ${file.name} » dans l'explorateur : ${errMsg(e)}`); }
    }
  }
  async dir() { try { return await invoke<string>('vault_dir'); } catch { return null; } }
  async keyState(): Promise<KeyState> {
    try {
      const k = await invoke<KeyState>('vault_key_state');
      return k.supported ? k : { ...dom, supported: false };
    } catch { return { ...dom, supported: false }; }
  }
  async pick(opts: { multiple: boolean; title: string; defaultPath?: string }): Promise<Picked[]> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ multiple: opts.multiple, directory: false, title: opts.title, defaultPath: opts.defaultPath });
    const list = r == null ? [] : Array.isArray(r) ? r : [r];
    return list.map(path => ({ path }));
  }
  async onChanged(cb: (ev: VaultChange) => void) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<VaultChange>('vault-changed', e => cb(e.payload));
  }
}

// ───────────────────────── Navigateur (IndexedDB) ─────────────────────────
const DB_NAME = 'prisme-vault'; const STORE = 'blobs';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error('IndexedDB : erreur inconnue')); });
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

class BrowserBackend implements Backend {
  readonly mode = 'browser' as const;
  private db: Promise<IDBDatabase> | null = null;
  private urls = new Map<string, string>();
  private ready: Promise<void> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') { rej(new Error('IndexedDB indisponible dans ce navigateur.')); return; }
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error ?? new Error('Ouverture du stockage local impossible.'));
    });
    return this.db;
  }
  private async store(mode: IDBTransactionMode) { return (await this.open()).transaction(STORE, mode).objectStore(STORE); }
  private async blob(hash: string): Promise<Blob> {
    const b = await req((await this.store('readonly')).get(hash)) as Blob | undefined;
    if (!b) throw new Error('Fichier absent du stockage local.');
    return b;
  }
  init() {
    // Précharge une URL blob par fichier : `url()` doit répondre de façon synchrone.
    this.ready ??= (async () => {
      try {
        const st = await this.store('readonly');
        const [keys, blobs] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
        keys.forEach((k, i) => { const b = blobs[i] as Blob | undefined; if (b && !this.urls.has(String(k))) this.urls.set(String(k), URL.createObjectURL(b)); });
      } catch (e) { console.warn('[fichiers] stockage local indisponible :', e); }
    })();
    return this.ready;
  }
  async importPath(): Promise<VaultEntry> {
    throw new Error("L'import par chemin de fichier nécessite l'application de bureau Prisme.");
  }
  async importBytes(name: string, mime: string, bytes: Uint8Array) {
    await this.init();
    const hash = await sha256Hex(bytes);
    const type = mime && mime !== 'application/octet-stream' ? mime : guessMime(name);
    if (!this.urls.has(hash)) {
      const blob = new Blob([bytes as unknown as ArrayBuffer], { type });
      await req((await this.store('readwrite')).put(blob, hash));
      this.urls.set(hash, URL.createObjectURL(blob));
    }
    const now = Date.now();
    return { hash, name: name.split(/[\\/]/).pop() || 'fichier', mime: type, size: bytes.byteLength, path: `idb:${hash}`, linked: false, addedAt: now, modifiedAt: now };
  }
  url(file: VaultFile) { return this.urls.get(file.hash) ?? ''; }
  async readText(file: VaultFile, maxBytes: number) {
    const buf = new Uint8Array(await (await this.blob(file.hash)).slice(0, maxBytes).arrayBuffer());
    if (buf.subarray(0, 8192).includes(0)) throw new Error('Fichier binaire : aucun aperçu texte disponible.');
    return new TextDecoder('utf-8').decode(buf);
  }
  async readBytes(file: VaultFile, offset: number, length: number) {
    return (await this.blob(file.hash)).slice(offset, offset + length).arrayBuffer();
  }
  async check(paths: string[]) {
    await this.init();
    return paths.filter(p => !(p.startsWith('idb:') && this.urls.has(p.slice(4))));
  }
  async watch() { /* pas de fichiers liés dans le navigateur */ }
  async remove(file: VaultFile) {
    await req((await this.store('readwrite')).delete(file.hash));
    const u = this.urls.get(file.hash); if (u) URL.revokeObjectURL(u);
    this.urls.delete(file.hash);
  }
  async openSystem(file: VaultFile) {
    const u = this.url(file);
    if (!u) throw new Error(`« ${file.name} » est introuvable dans le stockage local.`);
    window.open(u, '_blank', 'noopener');
  }
  async reveal(): Promise<void> { throw new Error("« Afficher dans l'explorateur » est disponible dans l'application de bureau."); }
  async dir() { return null; }
  async keyState() { return { ...dom, supported: false }; }
  pick(opts: { multiple: boolean; title: string }): Promise<Picked[]> {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = opts.multiple; input.style.display = 'none';
      let settled = false;
      const finish = (files: File[]) => { if (settled) return; settled = true; input.remove(); resolve(files.map(file => ({ file }))); };
      input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
      input.addEventListener('cancel', () => finish([]));
      document.body.appendChild(input);
      input.click();
    });
  }
  async onChanged() { return () => {}; }
}

export const backend: Backend = isTauri ? new TauriBackend() : new BrowserBackend();
export { errMsg };
