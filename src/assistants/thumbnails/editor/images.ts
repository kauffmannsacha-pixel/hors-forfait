// Images de l'éditeur : cache décodé (clé = source), import dans le vault pour l'autosauvegarde.
import { files } from '../../../files/api';
import { blobToBytes, decodeBlob, sizeOf, vaultBlob, type Drawable } from '../lib/browserImage';
import type { EditorDoc, ImageSrc } from './model';
import { srcKey } from './render';

export const imageCache = new Map<string, Drawable>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
export const onImagesChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Ajoute une image (importée dans le vault si possible, sinon gardée en mémoire pour la session). */
export async function addImageBlob(blob: Blob, name: string, opts: { hash?: string; persist?: boolean } = {}): Promise<{ src: ImageSrc; natW: number; natH: number; persisted: boolean }> {
  const img = await decodeBlob(blob);
  const { w, h } = sizeOf(img);
  let src: ImageSrc = { kind: 'memory', key: crypto.randomUUID(), name };
  let persisted = false;
  if (opts.hash) { src = { kind: 'vault', hash: opts.hash, name }; persisted = true; }
  else if (opts.persist !== false) {
    try { const f = await files.importBytes(name, blob.type || 'image/png', await blobToBytes(blob)); src = { kind: 'vault', hash: f.hash, name }; persisted = true; }
    catch { /* vault indisponible : image conservée en mémoire */ }
  }
  imageCache.set(srcKey(src), img); notify();
  return { src, natW: w, natH: h, persisted };
}
/** Charge les images du vault référencées par un document (après réouverture). */
export async function ensureImages(doc: EditorDoc): Promise<string[]> {
  const missing: string[] = [];
  for (const l of doc.layers) {
    if (l.type !== 'image' || imageCache.has(srcKey(l.src))) continue;
    if (l.src.kind !== 'vault') { missing.push(l.name); continue; }
    try { imageCache.set(srcKey(l.src), await decodeBlob(await vaultBlob(l.src.hash))); notify(); } catch { missing.push(l.name); }
  }
  return missing;
}
