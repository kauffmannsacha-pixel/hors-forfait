// ─────────────────────────────────────────────────────────────
// CONTRAT Fichiers épinglés / vault — implémenté par le module files.
// ─────────────────────────────────────────────────────────────
import type { VaultFile } from '../db/types';
type Impl = {
  /** Importe un fichier (chemin disque) dans le vault (copie dédupliquée par hash) ou le lie. */
  importPath: (path: string, opts?: { link?: boolean }) => Promise<VaultFile>;
  /** Importe des octets (pièce jointe mail, image générée, Drive…). */
  importBytes: (name: string, mime: string, bytes: Uint8Array) => Promise<VaultFile>;
  get: (hash: string) => Promise<VaultFile | undefined>;
  list: () => Promise<VaultFile[]>;
  /** Pages où le fichier est épinglé. */
  usages: (hash: string) => Promise<{ pageId: string; title: string }[]>;
  open: (hash: string, where?: 'panel' | 'system') => Promise<void>;
  /** URL affichable dans le webview (convertFileSrc). */
  url: (file: VaultFile) => string;
};
const notReady = async (): Promise<never> => { throw new Error('Module fichiers non initialisé'); };
let impl: Impl = { importPath: notReady, importBytes: notReady, get: async () => undefined, list: async () => [], usages: async () => [], open: notReady, url: f => f.path };
export const setFilesImpl = (i: Impl) => { impl = i; };
export const files = new Proxy({} as Impl, { get: (_t, k: keyof Impl) => impl[k] });
/** Nom du nœud TipTap inline de fichier épinglé (attrs: hash, name, mime). Pour insérer : editor.chain().insertContent({type: FILE_PIN_NODE, attrs}) */
export const FILE_PIN_NODE = 'filePin';
/** Type de données d'un glisser-déposer HTML5 de puce (JSON {hash, name, mime, linked}) : déposé dans un éditeur, il insère la puce. */
export const FILE_PIN_MIME = 'application/x-prisme-file-pin';
