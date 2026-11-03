// État réactif du vault (zustand) + persistance de l'index dans le kv du repo ('vault:index').
import { create } from 'zustand';
import { repo } from '../db/store';
import { toast } from '../ui/appState';
import { sanitizeIndex, type VaultIndex } from './indexLogic';

export const INDEX_KEY = 'vault:index';
export const LINK_DEFAULT_KEY = 'vault:linkByDefault';

interface VaultState {
  files: VaultIndex;
  loaded: boolean;
  /** Réglage : un dépôt lie le fichier au lieu de le copier (Alt inverse ce choix). */
  linkByDefault: boolean;
  /** Dossier du vault sur le disque (null dans le navigateur). */
  dir: string | null;
}
export const useVault = create<VaultState>(() => ({ files: {}, loaded: false, linkByDefault: false, dir: null }));

let loading: Promise<void> | null = null;
let canSave = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();

function scheduleSave() {
  if (!canSave) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const snapshot = useVault.getState().files;
    chain = chain
      .then(() => repo.kvSet(INDEX_KEY, snapshot))
      .catch(e => toast(`Enregistrement de l'index des fichiers impossible : ${e instanceof Error ? e.message : String(e)}`, 'error'));
  }, 120);
}

/** Charge l'index une seule fois. Si la lecture échoue, l'index n'est jamais réécrit (pas d'écrasement). */
export function loadVault(): Promise<void> {
  loading ??= (async () => {
    try {
      const [raw, link] = await Promise.all([repo.kvGet<unknown>(INDEX_KEY), repo.kvGet<boolean>(LINK_DEFAULT_KEY)]);
      // Les imports faits pendant le chargement sont conservés (fusion).
      useVault.setState(s => ({ files: { ...sanitizeIndex(raw), ...s.files }, linkByDefault: !!link, loaded: true }));
      canSave = true;
      if (Object.keys(useVault.getState().files).length !== Object.keys(sanitizeIndex(raw)).length) scheduleSave();
    } catch (e) {
      useVault.setState({ loaded: true });
      toast(`Index des fichiers illisible : ${e instanceof Error ? e.message : String(e)} — les modifications ne seront pas enregistrées.`, 'error');
    }
    useVault.subscribe((s, prev) => {
      if (s.files !== prev.files) scheduleSave();
      if (s.linkByDefault !== prev.linkByDefault && canSave) repo.kvSet(LINK_DEFAULT_KEY, s.linkByDefault).catch(() => {});
    });
  })();
  return loading;
}

export const setLinkByDefault = (v: boolean) => useVault.setState({ linkByDefault: v });
export const updateIndex = (fn: (files: VaultIndex) => VaultIndex) => useVault.setState(s => ({ files: fn(s.files) }));
