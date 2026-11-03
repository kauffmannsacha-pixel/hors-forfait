// Outils navigateur : téléchargement (sans canvas « tainted »), décodage, rastérisation, encodages.
import { httpError, httpFetch } from '../../../db/http';
import { isTauri } from '../../../db/store';
import { files } from '../../../files/api';
import { bytesToB64, detectLetterbox, type Rect, type RGBAImage } from './raster';

export type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement;
export type VisionMedia = 'image/jpeg' | 'image/png' | 'image/webp';
export interface VisionImage { base64: string; mediaType: VisionMedia }

export const sizeOf = (src: Drawable) => (src instanceof HTMLImageElement ? { w: src.naturalWidth, h: src.naturalHeight } : { w: src.width, h: src.height });
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c;
}
export function ctx2d(c: HTMLCanvasElement, read = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('Le rendu Canvas 2D est indisponible sur cet appareil.');
  return ctx;
}

/** Décode un blob image (ImageBitmap si possible, sinon <img> via URL objet). Jamais « tainted ». */
export async function decodeBlob(blob: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(blob); } catch { /* repli <img> */ } }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible (format non pris en charge).')); };
    img.src = url;
  });
}

const LOCAL_URL = /^(blob:|data:|asset:|tauri:|https?:\/\/(asset|tauri)\.localhost)/i;
/** Télécharge une image en blob : réseau via httpFetch (sans CORS), ressources locales via fetch natif. */
export async function fetchImageBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const local = LOCAL_URL.test(url) || url.startsWith('/');
  let r: Response;
  try { r = local ? await fetch(url, { signal }) : await httpFetch(url, { signal }); }
  catch (e) { if ((e as Error)?.name === 'AbortError') throw e; throw new Error(`Téléchargement impossible (${url.slice(0, 80)}) : ${(e as Error)?.message ?? e}`); }
  if (!r.ok) throw await httpError('Téléchargement de l\'image', r);
  const b = await r.blob();
  if (!b.size) throw new Error('Image vide.');
  if (b.type && !/^image\/|octet-stream/.test(b.type)) throw new Error(`Ce n'est pas une image (${b.type}).`);
  return b;
}

export const ytThumbUrl = (videoId: string, q: 'maxresdefault' | 'hqdefault' | 'mqdefault' | 'sddefault' = 'maxresdefault') => `https://i.ytimg.com/vi/${videoId}/${q}.jpg`;
/** Miniature d'une vidéo : maxresdefault (1280×720) puis repli hqdefault (480×360, bandes noires). */
export async function fetchYtThumbnail(videoId: string, apiUrl?: string, signal?: AbortSignal): Promise<{ blob: Blob; url: string }> {
  const candidates = [ytThumbUrl(videoId, 'maxresdefault'), ...(apiUrl && !apiUrl.includes('maxresdefault') ? [apiUrl] : []), ytThumbUrl(videoId, 'hqdefault')];
  let last: unknown;
  for (const url of [...new Set(candidates)]) {
    try { return { blob: await fetchImageBlob(url, signal), url }; }
    catch (e) { if ((e as Error)?.name === 'AbortError') throw e; last = e; }
  }
  throw last instanceof Error ? last : new Error('Miniature introuvable.');
}

/** Octets d'un fichier du vault (protocole asset de Tauri : CORS autorisé pour la fenêtre). */
export async function vaultBlob(hash: string): Promise<Blob> {
  const f = await files.get(hash);
  if (!f) throw new Error('Fichier introuvable dans le vault.');
  if (f.missing) throw new Error(`Le fichier lié « ${f.name} » a été déplacé ou supprimé.`);
  return fetchImageBlob(files.url(f));
}

/** Rastérise (fond noir sous la transparence) avec recadrage optionnel ; taille max 1280 px. */
export function rasterize(src: Drawable, opts: { crop?: Rect; maxW?: number; maxH?: number; background?: string } = {}): RGBAImage {
  const { w: sw, h: sh } = sizeOf(src);
  const crop = opts.crop ?? { x: 0, y: 0, w: sw, h: sh };
  const s = Math.min(1, (opts.maxW ?? 1280) / crop.w, (opts.maxH ?? 1280) / crop.h);
  const c = makeCanvas(crop.w * s, crop.h * s); const ctx = ctx2d(c, true);
  ctx.fillStyle = opts.background ?? '#000'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  try { const d = ctx.getImageData(0, 0, c.width, c.height); return { width: c.width, height: c.height, data: d.data }; }
  catch { throw new Error('Pixels inaccessibles (image d\'une autre origine) : mesures locales impossibles.'); }
}

/** Image prête pour l'analyse : rastérisée et débarrassée des bandes noires 4:3 éventuelles. */
export function analysisRaster(src: Drawable): { img: RGBAImage; crop?: Rect } {
  const full = rasterize(src);
  const lb = detectLetterbox(full);
  if (!lb) return { img: full };
  const { w, h } = sizeOf(src); const k = w / full.width;
  const crop = { x: lb.x * k, y: lb.y * (h / full.height), w: lb.w * k, h: lb.h * (h / full.height) };
  return { img: rasterize(src, { crop }), crop };
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('Encodage de l\'image impossible.'))), type, quality));
}
export async function blobToBase64(blob: Blob): Promise<string> { return bytesToB64(new Uint8Array(await blob.arrayBuffer())); }
export async function blobToBytes(blob: Blob): Promise<Uint8Array> { return new Uint8Array(await blob.arrayBuffer()); }

/** JPEG base64 pour Claude Vision (≤ maxW px de large ; ~0,8 k jetons à 1024 px). */
export async function toVisionJpeg(src: Drawable, opts: { maxW?: number; crop?: Rect; quality?: number } = {}): Promise<VisionImage> {
  const { w: sw, h: sh } = sizeOf(src);
  const crop = opts.crop ?? { x: 0, y: 0, w: sw, h: sh };
  const s = Math.min(1, (opts.maxW ?? 1024) / crop.w, 1024 / crop.h);
  const c = makeCanvas(crop.w * s, crop.h * s); const ctx = ctx2d(c);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  return { base64: await blobToBase64(await canvasToBlob(c, 'image/jpeg', opts.quality ?? 0.86)), mediaType: 'image/jpeg' };
}
/** Rendu « fil de suggestions » : 168×94 puis agrandi ×2 sans lissage (ce que voit réellement le spectateur). */
export function smallPreviewCanvas(src: Drawable, crop?: Rect, factor = 2): HTMLCanvasElement {
  const { w: sw, h: sh } = sizeOf(src); const r = crop ?? { x: 0, y: 0, w: sw, h: sh };
  const small = makeCanvas(168, 94); const sctx = ctx2d(small);
  sctx.imageSmoothingQuality = 'high'; sctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, 168, 94);
  if (factor === 1) return small;
  const big = makeCanvas(168 * factor, 94 * factor); const bctx = ctx2d(big);
  bctx.imageSmoothingEnabled = false; bctx.drawImage(small, 0, 0, big.width, big.height);
  return big;
}
export async function canvasToVision(c: HTMLCanvasElement): Promise<VisionImage> {
  return { base64: await blobToBase64(await canvasToBlob(c, 'image/png')), mediaType: 'image/png' };
}

/** Enregistre un fichier : boîte « Enregistrer sous » dans l'app, téléchargement dans le navigateur. */
export async function saveBlobAs(blob: Blob, name: string): Promise<boolean> {
  if (isTauri) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const ext = name.split('.').pop() ?? 'png';
      const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!path) return false;
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      await writeFile(path, await blobToBytes(blob));
      return true;
    } catch { /* permissions absentes : repli lien de téléchargement */ }
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

/** Image du presse-papiers ou d'un transfert (glisser-déposer). */
export function imageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) return f;
  for (const it of Array.from(dt.items ?? [])) if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) return f; }
  return null;
}
export const isImageMime = (m: string) => /^image\/(png|jpe?g|webp|gif|bmp|avif)$/i.test(m);
