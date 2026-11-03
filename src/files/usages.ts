// Où un fichier est-il épinglé ? Parcours du JSON TipTap de toutes les pages (module pur, testé).
import type { ID, Page } from '../db/types';
import { FILE_PIN_NODE } from './api';

export interface Usage {
  pageId: ID;
  title: string;
  icon?: string;
  /** Nombre de puces de ce fichier dans la page. */
  count: number;
  /** La page (ou un de ses parents) est dans la corbeille. */
  trashed: boolean;
  /** Référencé dans les propriétés de la page (ligne de base de données, propriété « fichier »). */
  inProps: boolean;
}

const HASH_RE = /\b[0-9a-f]{64}\b/g;
const HTML_PIN_RE = /data-file-pin[^>]*?data-hash="([^"]+)"|data-hash="([^"]+)"[^>]*?data-file-pin/g;

/** Compte les nœuds `filePin` d'un document TipTap (objet JSON, chaîne JSON ou HTML), par hash. */
export function collectPins(doc: unknown, out: Map<string, number> = new Map()): Map<string, number> {
  if (typeof doc === 'string') {
    const s = doc.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return collectPins(JSON.parse(s), out); } catch { /* HTML ou texte : on continue */ }
    }
    for (const m of s.matchAll(HTML_PIN_RE)) { const h = m[1] ?? m[2]; if (h) out.set(h, (out.get(h) ?? 0) + 1); }
    return out;
  }
  // Parcours itératif (pas de récursion profonde sur les gros documents).
  const stack: unknown[] = [doc];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) { for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]); continue; }
    const node = n as { type?: unknown; attrs?: { hash?: unknown } | null; content?: unknown };
    if (node.type === FILE_PIN_NODE) {
      const h = node.attrs?.hash;
      if (typeof h === 'string' && h) out.set(h, (out.get(h) ?? 0) + 1);
    }
    if (node.content) stack.push(node.content);
  }
  return out;
}

/** Hashes (sha256) cités dans les propriétés d'une page (ex. propriété « fichier » d'une base). */
export function hashesInProps(props: unknown): Set<string> {
  if (!props || typeof props !== 'object') return new Set();
  let s = '';
  try { s = JSON.stringify(props); } catch { return new Set(); }
  return new Set(s.match(HASH_RE) ?? []);
}

/** La page ou un de ses ancêtres est-il dans la corbeille ? */
export function inTrash(id: ID, pages: Record<ID, Page>): boolean {
  const seen = new Set<ID>();
  let cur: ID | null = id;
  while (cur && pages[cur] && !seen.has(cur)) {
    if (pages[cur].trashed) return true;
    seen.add(cur); cur = pages[cur].parentId;
  }
  return false;
}

interface PageScan { pins: Map<string, number>; props: Set<string> }
// Cache par objet Page : les pages non modifiées (même référence) ne sont pas re-parcourues.
const scans = new WeakMap<Page, PageScan>();
function scan(p: Page): PageScan {
  let s = scans.get(p);
  if (!s) { s = { pins: collectPins(p.content), props: hashesInProps(p.props) }; scans.set(p, s); }
  return s;
}

const titleOf = (p: Page) => (p.title?.trim() ? p.title : 'Sans titre');

/** Pages où le fichier `hash` est épinglé (corbeille comprise, signalée par `trashed`). */
export function usagesOf(hash: string, pages: Record<ID, Page>): Usage[] {
  const out: Usage[] = [];
  for (const p of Object.values(pages)) {
    const s = scan(p);
    const count = s.pins.get(hash) ?? 0;
    const inProps = s.props.has(hash);
    if (count || inProps) out.push({ pageId: p.id, title: titleOf(p), icon: p.icon, count, inProps, trashed: inTrash(p.id, pages) });
  }
  return out.sort((a, b) => Number(a.trashed) - Number(b.trashed) || a.title.localeCompare(b.title, 'fr'));
}

/** Index complet hash → usages (vue Fichiers : une seule passe sur toutes les pages). */
export function usageIndex(pages: Record<ID, Page>): Map<string, Usage[]> {
  const idx = new Map<string, Usage[]>();
  for (const p of Object.values(pages)) {
    const s = scan(p);
    const hashes = new Set<string>([...s.pins.keys(), ...s.props]);
    if (!hashes.size) continue;
    const trashed = inTrash(p.id, pages);
    for (const h of hashes) {
      const u: Usage = { pageId: p.id, title: titleOf(p), icon: p.icon, count: s.pins.get(h) ?? 0, inProps: s.props.has(h), trashed };
      const list = idx.get(h); if (list) list.push(u); else idx.set(h, [u]);
    }
  }
  for (const list of idx.values()) list.sort((a, b) => Number(a.trashed) - Number(b.trashed) || a.title.localeCompare(b.title, 'fr'));
  return idx;
}
