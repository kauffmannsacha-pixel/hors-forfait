// Miniatures : URL affichable, base64 pour Claude Vision, préparation à l'envoi (JPEG/PNG ≤ 2 Mo, 1280×720 max).
import { files } from '../files/api';
import { isTauri } from '../db/store';
import { THUMB_MAX_BYTES } from './metadata';
import type { DraftImage } from './types';

/** URL utilisable dans <img> (vault → protocole asset ; chemin disque → convertFileSrc). */
export async function imageUrl(img: DraftImage | undefined | null): Promise<string | null> {
  if (!img) return null;
  if (img.hash) { const f = await files.get(img.hash).catch(() => undefined); if (f && !f.missing) return files.url(f); }
  if (isTauri && img.path) { const { convertFileSrc } = await import('@tauri-apps/api/core'); return convertFileSrc(img.path); }
  return null;
}

async function blobOf(img: DraftImage): Promise<Blob> {
  const url = await imageUrl(img);
  if (!url) throw new Error('Image introuvable.');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image illisible (${r.status}).`);
  return r.blob();
}
async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(blob); } catch { /* repli */ } }
  return new Promise((res, rej) => { const u = URL.createObjectURL(blob); const i = new Image(); i.onload = () => { URL.revokeObjectURL(u); res(i); }; i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Format d’image non pris en charge.')); }; i.src = u; });
}
const dims = (s: ImageBitmap | HTMLImageElement) => ('naturalWidth' in s ? { w: s.naturalWidth, h: s.naturalHeight } : { w: s.width, h: s.height });

async function toJpeg(src: ImageBitmap | HTMLImageElement, maxW: number, quality: number): Promise<Blob> {
  const { w, h } = dims(src);
  const k = Math.min(1, maxW / w);
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d'); if (!ctx) throw new Error('Canvas indisponible.');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Encodage JPEG impossible.'))), 'image/jpeg', quality));
}

const b64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Image en base64 pour scoreThumbnail (JPEG 1280 px max). */
export async function imageForVision(img: DraftImage): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  const blob = await blobOf(img);
  if (/image\/(png|jpeg|webp)/.test(blob.type) && blob.size < 3.5 * 1024 * 1024) return { base64: await b64(blob), mediaType: blob.type as 'image/png' };
  return { base64: await b64(await toJpeg(await decode(blob), 1280, 0.88)), mediaType: 'image/jpeg' };
}

/** Chemin d'un fichier JPEG/PNG ≤ 2 Mo prêt pour thumbnails.set (recompressé dans le vault si besoin). */
export async function prepareThumbnail(img: DraftImage): Promise<{ path: string; hash?: string }> {
  const okType = /\.(jpe?g|png)$/i.test(img.path) || /image\/(jpeg|png)/.test(img.mime ?? '');
  if (okType && img.size != null && img.size <= THUMB_MAX_BYTES) return { path: img.path, hash: img.hash };
  const src = await decode(await blobOf(img));
  let out: Blob | null = null;
  for (const q of [0.92, 0.85, 0.78, 0.7, 0.6]) { out = await toJpeg(src, 1280, q); if (out.size <= THUMB_MAX_BYTES) break; }
  if (!out || out.size > THUMB_MAX_BYTES) throw new Error('Impossible de ramener la miniature sous 2 Mo.');
  const vf = await files.importBytes(img.name.replace(/\.[^.]+$/, '') + '-youtube.jpg', 'image/jpeg', new Uint8Array(await out.arrayBuffer()));
  return { path: vf.path, hash: vf.hash };
}

/** Télécharge la miniature actuelle d'une vidéo dans le vault (variante « originale » d'un test A/B). */
export async function importCurrentThumbnail(videoId: string, thumbs?: Record<string, { url?: string }>): Promise<DraftImage | null> {
  const { httpFetch } = await import('../db/http');
  const urls = [thumbs?.maxres?.url, thumbs?.standard?.url, `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, thumbs?.high?.url].filter((u): u is string => !!u);
  for (const u of [...new Set(urls)]) {
    try {
      const r = await httpFetch(u); if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer()); if (bytes.length < 2000) continue;
      const vf = await files.importBytes(`miniature-${videoId}.jpg`, 'image/jpeg', bytes);
      return { path: vf.path, name: vf.name, hash: vf.hash, mime: vf.mime, size: vf.size };
    } catch { /* suivante */ }
  }
  return null;
}
