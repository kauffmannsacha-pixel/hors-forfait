// Contexte automatique envoyé à Claude : page ouverte (Markdown), sélection, fichiers épinglés
// (extrait pour le texte/code, image via Vision, PDF en document).
import type Anthropic from '@anthropic-ai/sdk';
import { getPage, displayTitle } from '../db/pages';
import { isTauri } from '../db/store';
import type { VaultFile } from '../db/types';
import { files } from '../files/api';
import { getActiveEditor } from '../editor/active';
import { currentPageId, useApp } from '../ui/appState';
import type { ModelCaps } from './modelCaps';
import { clipText, docToMarkdown, extractFileRefs, type PageFileRef } from './pageText';
import { shortHash } from './toolNames';

type Block = Anthropic.Beta.BetaContentBlockParam;

export const CONTEXT_TAG = 'contexte_prisme';
export const MAX_PAGE_CHARS = 200_000;
export const MAX_SELECTION_CHARS = 20_000;
export const MAX_FILE_EXCERPT = 20_000;
export const MAX_IMAGES = 5;
const MAX_IMAGE_SIDE = 1568;
const MAX_IMAGE_BYTES = 3_700_000;
const MAX_PDF_BYTES = 10_000_000;

export type FileKind = 'text' | 'image' | 'pdf' | 'other';

const TEXT_EXT = new Set(('txt md markdown csv tsv json jsonc yaml yml toml ini cfg conf log srt vtt sbv html htm css scss less xml svg ' +
  'js mjs cjs jsx ts tsx lua py rb php java kt kts swift go rs c h cpp hpp cc cs fs vb sql sh bash zsh ps1 psm1 bat cmd ' +
  'r m mm dart scala clj ex exs erl hs elm vue svelte astro gradle properties env gitignore dockerfile makefile tex bib rst adoc org').split(' '));
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Catégorie d'un fichier (nom + type MIME). */
export function fileKind(name: string, mime: string): FileKind {
  const m = (mime || '').toLowerCase();
  const ext = (/\.([^.\\/]+)$/.exec(name.toLowerCase())?.[1]) ?? (name.toLowerCase().match(/^(dockerfile|makefile)$/)?.[1] ?? '');
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (IMAGE_MIME.has(m) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (m.startsWith('text/') || /(json|xml|javascript|typescript|x-sh|x-lua|x-python|yaml|toml|sql|csv|x-subrip)/.test(m) || TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

export function imageMediaType(name: string, mime: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  const m = mime.toLowerCase();
  if (IMAGE_MIME.has(m)) return (m === 'image/jpg' ? 'image/jpeg' : m) as 'image/png';
  const ext = /\.([^.]+)$/.exec(name.toLowerCase())?.[1];
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
const escAttr = (v: string) => v.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c] as string));

// ───────────────────────────── Instantané ─────────────────────────────

export interface ContextSnapshot {
  pageId: string | null;
  pageTitle: string;
  pageKind: string;
  pageMarkdown: string;
  selection: string;
  files: PageFileRef[];
}

/** Lit l'état courant : page ouverte (contenu en direct de l'éditeur si disponible), sélection, fichiers. */
export function snapshotContext(): ContextSnapshot {
  const pageId = currentPageId();
  const page = pageId ? getPage(pageId) : undefined;
  const active = getActiveEditor();
  const doc = active && active.pageId === pageId && pageId ? active.editor.getJSON() : page?.content;
  return {
    pageId: page ? page.id : null,
    pageTitle: page ? displayTitle(page) : '',
    pageKind: page?.kind ?? '',
    pageMarkdown: page ? docToMarkdown(doc) : '',
    selection: (useApp.getState().selectionText ?? '').trim(),
    files: page ? extractFileRefs(doc) : [],
  };
}

export interface ContextToggles { page: boolean; selection: boolean; files: Record<string, boolean> }
export const defaultToggles = (): ContextToggles => ({ page: true, selection: true, files: {} });
export const fileEnabled = (t: ContextToggles, hash: string) => t.files[hash] !== false;

/** Ce qui a déjà été transmis dans la conversation (pour ne pas renvoyer le même contenu). */
export interface SentState { pageId?: string; pageHash?: string; files: string[] }

// ───────────────────────────── Lecture des fichiers ─────────────────────────────

async function readVaultBytes(file: VaultFile, maxBytes?: number): Promise<Uint8Array> {
  if (isTauri) {
    try {
      const fs = await import('@tauri-apps/plugin-fs');
      const data = await fs.readFile(file.path);
      return maxBytes && data.length > maxBytes ? data.subarray(0, maxBytes) : data;
    } catch { /* repli : protocole asset */ }
  }
  const r = await fetch(files.url(file));
  if (!r.ok) throw new Error(`Lecture impossible de « ${file.name} » (${r.status}).`);
  const data = new Uint8Array(await r.arrayBuffer());
  return maxBytes && data.length > maxBytes ? data.subarray(0, maxBytes) : data;
}

/** Image redimensionnée (côté max 1568 px) et encodée pour Claude Vision. */
async function prepareImage(bytes: Uint8Array, name: string, mime: string): Promise<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64: string }> {
  const mediaType = imageMediaType(name, mime);
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return { mediaType, base64: bytesToBase64(bytes) };
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType })); } catch { return { mediaType, base64: bytesToBase64(bytes) }; }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  if (scale >= 1 && bytes.length <= MAX_IMAGE_BYTES) { bmp.close(); return { mediaType, base64: bytesToBase64(bytes) }; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) { bmp.close(); return { mediaType, base64: bytesToBase64(bytes) }; }
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const outType = mediaType === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, outType, 0.86));
  if (!blob) return { mediaType, base64: bytesToBase64(bytes) };
  return { mediaType: outType, base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
}

// ───────────────────────────── Construction du message ─────────────────────────────

export interface BuiltUserContent {
  content: Block[];
  labels: string[];
  sent: SentState;
  warnings: string[];
}

/** Date lisible pour le contexte (« mardi 3 novembre 2026, 19:30 »). */
export function frenchNow(d = new Date()): string {
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Construit le contenu du message utilisateur : pièces jointes (images, PDF), bloc <contexte_prisme>,
 * puis le texte saisi. Le contexte inchangé depuis le message précédent n'est pas renvoyé.
 */
export async function buildUserContent(
  text: string,
  snap: ContextSnapshot,
  toggles: ContextToggles,
  prev: SentState,
  caps: Pick<ModelCaps, 'vision' | 'pdf'>,
  attachments: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64: string; name: string }[] = [],
): Promise<BuiltUserContent> {
  const media: Block[] = []; const labels: string[] = []; const warnings: string[] = [];
  const sent: SentState = { pageId: prev.pageId, pageHash: prev.pageHash, files: [...prev.files] };
  const parts: string[] = [`Date : ${frenchNow()}.`];

  if (snap.pageId && toggles.page) {
    const hash = shortHash(snap.pageMarkdown) + ':' + snap.pageMarkdown.length;
    const head = `<page id="${escAttr(snap.pageId)}" titre="${escAttr(snap.pageTitle)}"${snap.pageKind && snap.pageKind !== 'page' ? ` type="${escAttr(snap.pageKind)}"` : ''}`;
    if (prev.pageId === snap.pageId && prev.pageHash === hash) {
      parts.push(`${head} inchangee="oui">(contenu identique à celui transmis plus haut)</page>`);
    } else {
      const clip = clipText(snap.pageMarkdown || '(page vide)', MAX_PAGE_CHARS);
      parts.push(`${head}>\n${clip.text}\n</page>`);
      if (clip.truncated) warnings.push('La page est très longue : seul le début a été transmis à Claude.');
    }
    sent.pageId = snap.pageId; sent.pageHash = hash;
    labels.push(`Page « ${snap.pageTitle} »`);
  } else if (snap.pageId) {
    parts.push(`(La page ouverte « ${snap.pageTitle} » n'est pas partagée avec toi pour ce message.)`);
  }

  if (snap.selection && toggles.selection) {
    const clip = clipText(snap.selection, MAX_SELECTION_CHARS);
    parts.push(`<selection>\n${clip.text}\n</selection>`);
    labels.push(`Sélection (${snap.selection.length.toLocaleString('fr-FR')} car.)`);
  }

  const chosen = snap.files.filter(f => fileEnabled(toggles, f.hash));
  if (chosen.length) {
    const fileParts: string[] = []; let images = 0;
    for (const ref of chosen) {
      const vf = await files.get(ref.hash).catch(() => undefined);
      const name = vf?.name ?? ref.name; const mime = vf?.mime ?? ref.mime;
      const kind = fileKind(name, mime);
      const attrs = `nom="${escAttr(name)}" type="${escAttr(mime || 'inconnu')}"${vf ? ` taille="${fmtSize(vf.size)}"` : ''} hash="${escAttr(ref.hash)}"`;
      if (!vf || vf.missing) { fileParts.push(`<fichier ${attrs} statut="introuvable"/>`); continue; }
      if (sent.files.includes(ref.hash) && kind !== 'other') { fileParts.push(`<fichier ${attrs}>(déjà transmis plus haut dans la conversation)</fichier>`); labels.push(`📎 ${name}`); continue; }
      try {
        if (kind === 'text') {
          const bytes = await readVaultBytes(vf, MAX_FILE_EXCERPT * 4);
          const clip = clipText(new TextDecoder('utf-8').decode(bytes), MAX_FILE_EXCERPT);
          const partial = clip.truncated || vf.size > bytes.length;
          fileParts.push(`<fichier ${attrs}${partial ? ' extrait="oui"' : ''}>\n${clip.text}${partial && !clip.truncated ? '\n[… extrait : début du fichier seulement]' : ''}\n</fichier>`);
          sent.files.push(ref.hash); labels.push(`📄 ${name}`);
        } else if (kind === 'image' && caps.vision && images < MAX_IMAGES) {
          const img = await prepareImage(await readVaultBytes(vf), name, mime);
          media.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
          fileParts.push(`<fichier ${attrs}>(image jointe à ce message)</fichier>`);
          sent.files.push(ref.hash); labels.push(`🖼 ${name}`); images++;
        } else if (kind === 'pdf' && caps.pdf && vf.size <= MAX_PDF_BYTES) {
          const bytes = await readVaultBytes(vf);
          media.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(bytes) }, title: name });
          fileParts.push(`<fichier ${attrs}>(document PDF joint à ce message)</fichier>`);
          sent.files.push(ref.hash); labels.push(`📕 ${name}`);
        } else {
          const why = kind === 'image' ? (images >= MAX_IMAGES ? 'trop d\'images pour un seul message' : 'images non prises en charge par ce modèle')
            : kind === 'pdf' ? 'PDF trop volumineux (10 Mo max)' : 'contenu binaire non lisible';
          fileParts.push(`<fichier ${attrs}>(nom seulement : ${why})</fichier>`);
          labels.push(`📎 ${name}`);
        }
      } catch (e) {
        fileParts.push(`<fichier ${attrs} statut="illisible"/>`);
        warnings.push(`Lecture impossible de « ${name} » : ${(e as Error).message}`);
      }
    }
    parts.push(`<fichiers_epingles>\n${fileParts.join('\n')}\n</fichiers_epingles>`);
  }

  for (const a of attachments) {
    if (!caps.vision) { warnings.push(`Image « ${a.name} » ignorée : le modèle choisi ne lit pas les images.`); continue; }
    media.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } });
    labels.push(`🖼 ${a.name}`);
  }

  const contextText = `<${CONTEXT_TAG}>\n${parts.join('\n')}\n</${CONTEXT_TAG}>`;
  const content: Block[] = [...media, { type: 'text', text: contextText }, { type: 'text', text: text.trim() || '(voir les pièces jointes)' }];
  return { content, labels, sent, warnings };
}

export const isContextText = (t: string) => t.startsWith(`<${CONTEXT_TAG}>`);
