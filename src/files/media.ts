// Aperçus calculés côté webview, mis en cache : 1re image d'une vidéo (seek 0,1 s → canvas),
// miniature intégrée d'un .psd, extrait texte d'un fichier de code.
import type { VaultFile } from '../db/types';
import { backend } from './backend';
import { parsePsd } from './psd';

export interface VideoThumb { dataUrl: string | null; width: number; height: number; duration: number }

const LIMIT = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= LIMIT) await new Promise<void>(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

function grabFrame(url: string): Promise<VideoThumb> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const cleanup = () => { clearTimeout(timer); v.removeAttribute('src'); v.load(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Délai dépassé pour la lecture de la vidéo.')); }, 12_000);
    v.addEventListener('loadeddata', () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); }, { once: true });
    v.addEventListener('seeked', () => {
      const w = v.videoWidth; const h = v.videoHeight;
      let dataUrl: string | null = null;
      if (w && h) {
        const scale = Math.min(1, 640 / w);
        const c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
        try { dataUrl = c.toDataURL('image/jpeg', 0.82); } catch { dataUrl = null; } // canvas « teinté » : repli sur <video>
      }
      const out = { dataUrl, width: w, height: h, duration: v.duration };
      cleanup(); resolve(out);
    }, { once: true });
    v.addEventListener('error', () => { cleanup(); reject(new Error('Format vidéo non pris en charge par le lecteur intégré.')); }, { once: true });
    v.src = url;
  });
}

const frames = new Map<string, Promise<VideoThumb | null>>();
/** Première image (0,1 s) d'une vidéo, ou null si illisible. */
export function videoThumb(file: VaultFile): Promise<VideoThumb | null> {
  const key = `${file.hash}:${file.path}`;
  let p = frames.get(key);
  if (!p) {
    const url = backend.url(file);
    p = url ? slot(() => grabFrame(url)).catch(() => null) : Promise.resolve(null);
    frames.set(key, p);
  }
  return p;
}

const psds = new Map<string, Promise<{ url: string | null; width: number; height: number } | null>>();
/** Miniature JPEG intégrée d'un fichier Photoshop (+ dimensions du document). */
export function psdThumb(file: VaultFile): Promise<{ url: string | null; width: number; height: number } | null> {
  const key = `${file.hash}:${file.path}`;
  let p = psds.get(key);
  if (!p) {
    p = (async () => {
      let buf = await backend.readBytes(file, 0, 1 << 20);
      let info = parsePsd(buf);
      if (info?.needBytes && info.needBytes > buf.byteLength && info.needBytes <= 32 << 20) {
        buf = await backend.readBytes(file, 0, info.needBytes);
        info = parsePsd(buf);
      }
      if (!info) return null;
      const url = info.thumbnail ? URL.createObjectURL(new Blob([info.thumbnail.data as unknown as ArrayBuffer], { type: 'image/jpeg' })) : null;
      return { url, width: info.width, height: info.height };
    })().catch(() => null);
    psds.set(key, p);
  }
  return p;
}

const texts = new Map<string, Promise<string>>();
/** Début du fichier en texte (mis en cache par version du fichier). */
export function textExcerpt(file: VaultFile & { modifiedAt?: number }, maxBytes = 16 * 1024): Promise<string> {
  const key = `${file.hash}:${file.path}:${file.modifiedAt ?? ''}:${maxBytes}`;
  let p = texts.get(key);
  if (!p) {
    p = backend.readText(file, maxBytes);
    p.catch(() => texts.delete(key));
    texts.set(key, p);
    if (texts.size > 60) texts.delete(texts.keys().next().value as string);
  }
  return p;
}

/** Premières lignes d'un texte (sans la dernière ligne coupée si le texte est tronqué). */
export function firstLines(text: string, n: number, truncated = false): { lines: string[]; more: boolean } {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  if (truncated && all.length > 1) all.pop();
  return { lines: all.slice(0, n), more: all.length > n || truncated };
}
