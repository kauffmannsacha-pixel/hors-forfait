// Logique pure de l'index du vault (kv 'vault:index') : fusion des imports (déduplication par hash),
// fichiers liés introuvables / déplacés, filtres, tri, statistiques. Testé dans __tests__/indexLogic.test.ts.
import type { VaultFile } from '../db/types';
import { fileKind, groupOf, type KindGroup } from './kinds';

/** Entrée de l'index : VaultFile + champs optionnels propres au module. */
export interface VaultEntry extends VaultFile {
  /** Date de modification du fichier (ms). */
  modifiedAt?: number;
  /** Fichier copié : chemin d'origine au moment de l'import. */
  originalPath?: string;
}
export type VaultIndex = Record<string, VaultEntry>;

/** Événement `vault-changed` émis par Rust. */
export interface VaultChange { path: string; kind: 'removed' | 'renamed' | 'modified'; newPath?: string; guess?: boolean; size?: number; modifiedAt?: number }

/** Clé de comparaison de chemins : séparateurs unifiés, insensible à la casse pour les chemins Windows. */
export function pathKey(p: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
  const s = windows ? p.replace(/\//g, '\\') : p;
  return windows ? s.toLowerCase() : s;
}

/** Valide/complète un index lu depuis le stockage (tolère tableau ou objet, ignore les entrées invalides). */
export function sanitizeIndex(raw: unknown): VaultIndex {
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw as object) : [];
  const out: VaultIndex = {};
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Partial<VaultEntry>;
    if (typeof e.hash !== 'string' || !e.hash || typeof e.path !== 'string') continue;
    out[e.hash] = {
      ...(e as VaultEntry),
      name: typeof e.name === 'string' && e.name ? e.name : 'fichier',
      mime: typeof e.mime === 'string' && e.mime ? e.mime : 'application/octet-stream',
      size: typeof e.size === 'number' && e.size >= 0 ? e.size : 0,
      linked: !!e.linked,
      addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
    };
  }
  return out;
}

const clean = (e: VaultEntry): VaultEntry => { const c = { ...e }; if (!c.missing) delete c.missing; return c; };

export type MergeStatus = 'added' | 'existing' | 'repaired';
export interface MergeResult {
  index: VaultIndex;
  entry: VaultEntry;
  status: MergeStatus;
  /** Copie superflue écrite dans le vault (le contenu existe déjà sous forme liée) : à supprimer. */
  orphanCopy?: string;
}

/**
 * Fusionne un fichier fraîchement importé (résultat Rust) dans l'index.
 * Règles : même hash → même entrée (la première gagne : nom, date d'ajout, mode) ;
 * re-lier le même chemin → même entrée (même si le contenu a changé depuis) ;
 * une entrée introuvable est réparée par un import du même contenu.
 */
export function mergeImport(index: VaultIndex, incoming: VaultEntry): MergeResult {
  if (incoming.linked) {
    const k = pathKey(incoming.path);
    const byPath = Object.values(index).find(e => e.linked && pathKey(e.path) === k);
    if (byPath) {
      const entry = clean({ ...byPath, size: incoming.size, modifiedAt: incoming.modifiedAt ?? byPath.modifiedAt, missing: undefined });
      return { index: { ...index, [entry.hash]: entry }, entry, status: byPath.missing ? 'repaired' : 'existing' };
    }
  }
  const existing = index[incoming.hash];
  if (!existing) {
    const entry = clean({ ...incoming });
    return { index: { ...index, [entry.hash]: entry }, entry, status: 'added' };
  }
  if (existing.missing) {
    // Même contenu retrouvé : on répare l'entrée avec le nouvel emplacement (copie ou lien).
    const entry = clean({
      ...existing, path: incoming.path, linked: incoming.linked, size: incoming.size, missing: undefined,
      modifiedAt: incoming.modifiedAt ?? existing.modifiedAt, originalPath: incoming.originalPath ?? existing.originalPath,
    });
    return { index: { ...index, [entry.hash]: entry }, entry, status: 'repaired' };
  }
  if (!existing.linked && !incoming.linked && existing.path !== incoming.path) {
    // Copie déjà présente : on garde l'entrée, en suivant le fichier réellement présent dans le vault.
    const entry = clean({ ...existing, path: incoming.path });
    return { index: { ...index, [entry.hash]: entry }, entry, status: 'existing' };
  }
  const orphanCopy = existing.linked && !incoming.linked && incoming.path !== existing.path ? incoming.path : undefined;
  return { index, entry: existing, status: 'existing', orphanCopy };
}

/** Entrées liées dont le chemin correspond. */
export const linkedAt = (index: VaultIndex, path: string) => {
  const k = pathKey(path);
  return Object.values(index).filter(e => e.linked && pathKey(e.path) === k);
};

/** Applique un événement de surveillance. `restored` = l'entrée était introuvable et réapparaît. */
export function applyChange(index: VaultIndex, ev: VaultChange): { index: VaultIndex; affected: VaultEntry[]; restored: VaultEntry[] } {
  const hits = linkedAt(index, ev.path);
  if (!hits.length) return { index, affected: [], restored: [] };
  const next = { ...index };
  const affected: VaultEntry[] = []; const restored: VaultEntry[] = [];
  for (const e of hits) {
    let u: VaultEntry;
    if (ev.kind === 'removed') u = { ...e, missing: true };
    else if (ev.kind === 'renamed' && ev.newPath) u = clean({ ...e, path: ev.newPath, missing: undefined, size: ev.size ?? e.size, modifiedAt: ev.modifiedAt ?? e.modifiedAt });
    else u = clean({ ...e, missing: undefined, size: ev.size ?? e.size, modifiedAt: ev.modifiedAt ?? e.modifiedAt });
    if (e.missing && !u.missing) restored.push(u);
    next[u.hash] = u; affected.push(u);
  }
  return { index: next, affected, restored };
}

/** Résultat de `vault_check` (chemins introuvables) appliqué à toutes les entrées vérifiées. */
export function applyCheck(index: VaultIndex, checkedPaths: string[], missingPaths: string[]): { index: VaultIndex; newlyMissing: VaultEntry[]; restored: VaultEntry[] } {
  const checked = new Set(checkedPaths.map(pathKey));
  const missing = new Set(missingPaths.map(pathKey));
  const next: VaultIndex = {}; const newlyMissing: VaultEntry[] = []; const restored: VaultEntry[] = [];
  for (const [h, e] of Object.entries(index)) {
    const k = pathKey(e.path);
    if (!checked.has(k)) { next[h] = e; continue; }
    const isMissing = missing.has(k);
    if (isMissing && !e.missing) { const u = { ...e, missing: true }; newlyMissing.push(u); next[h] = u; }
    else if (!isMissing && e.missing) { const u = clean({ ...e, missing: undefined }); restored.push(u); next[h] = u; }
    else next[h] = e;
  }
  return { index: next, newlyMissing, restored };
}

/** Nouvel emplacement d'un fichier (relocalisation manuelle). */
export function relocateEntry(index: VaultIndex, hash: string, path: string, info: { size?: number; modifiedAt?: number } = {}): VaultIndex {
  const e = index[hash]; if (!e) return index;
  return { ...index, [hash]: clean({ ...e, path, missing: undefined, size: info.size ?? e.size, modifiedAt: info.modifiedAt ?? e.modifiedAt }) };
}

export function removeEntry(index: VaultIndex, hash: string): VaultIndex {
  if (!index[hash]) return index;
  const next = { ...index }; delete next[hash]; return next;
}

/** Chemins à surveiller : fichiers liés (y compris introuvables, pour détecter leur retour). */
export const watchPaths = (index: VaultIndex) => Object.values(index).filter(e => e.linked).map(e => e.path);

// ───────────── Vue Fichiers : filtre, tri, stats ─────────────
export type SortKey = 'recent' | 'name' | 'size' | 'type' | 'usage';
export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'recent', label: 'Ajout récent' }, { id: 'name', label: 'Nom' }, { id: 'size', label: 'Taille' },
  { id: 'type', label: 'Type' }, { id: 'usage', label: 'Utilisation' },
];
export type StateFilter = 'all' | 'linked' | 'copied' | 'missing' | 'unused';

/** Minuscules sans accents (recherche tolérante : « video » trouve « Vidéo »). */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterFiles(list: VaultEntry[], opts: { query?: string; group?: KindGroup; state?: StateFilter; usageCount?: (hash: string) => number }): VaultEntry[] {
  const terms = fold(opts.query ?? '').split(/\s+/).filter(Boolean);
  return list.filter(f => {
    if (opts.group && opts.group !== 'all' && groupOf(fileKind(f.name, f.mime)) !== opts.group) return false;
    switch (opts.state) {
      case 'linked': if (!f.linked) return false; break;
      case 'copied': if (f.linked) return false; break;
      case 'missing': if (!f.missing) return false; break;
      case 'unused': if ((opts.usageCount?.(f.hash) ?? 0) > 0) return false; break;
    }
    if (!terms.length) return true;
    const hay = fold(`${f.name} ${f.path} ${f.originalPath ?? ''}`);
    return terms.every(t => hay.includes(t));
  });
}

export function sortFiles(list: VaultEntry[], key: SortKey, usageCount: (hash: string) => number = () => 0): VaultEntry[] {
  const byName = (a: VaultEntry, b: VaultEntry) => a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' });
  const cmp: Record<SortKey, (a: VaultEntry, b: VaultEntry) => number> = {
    recent: (a, b) => b.addedAt - a.addedAt || byName(a, b),
    name: byName,
    size: (a, b) => b.size - a.size || byName(a, b),
    type: (a, b) => fileKind(a.name, a.mime).localeCompare(fileKind(b.name, b.mime)) || byName(a, b),
    usage: (a, b) => usageCount(b.hash) - usageCount(a.hash) || byName(a, b),
  };
  return [...list].sort(cmp[key]);
}

export interface VaultStats { count: number; totalSize: number; copiedSize: number; linkedCount: number; missingCount: number }
export function vaultStats(list: VaultEntry[]): VaultStats {
  const s: VaultStats = { count: list.length, totalSize: 0, copiedSize: 0, linkedCount: 0, missingCount: 0 };
  for (const f of list) {
    s.totalSize += f.size;
    if (f.linked) s.linkedCount++; else s.copiedSize += f.size;
    if (f.missing) s.missingCount++;
  }
  return s;
}
