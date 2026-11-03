// Import de médias (images, vidéos, audio, fichiers) : vault en Tauri, data URL en repli navigateur.
import { isTauri } from '../db/store';
import { files } from '../files/api';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export interface MediaResult { src: string; hash?: string; name: string; mime: string; size?: number }

export const MEDIA_LABEL: Record<MediaKind, string> = { image: 'Image', video: 'Vidéo', audio: 'Audio', file: 'Fichier' };
const ACCEPT: Record<MediaKind, { exts: string[]; accept: string }> = {
  image: { exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'], accept: 'image/*' },
  video: { exts: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'], accept: 'video/*' },
  audio: { exts: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus'], accept: 'audio/*' },
  file: { exts: [], accept: '' },
};
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
};
export const guessMime = (name: string) => MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export function formatBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1).replace('.', ',')} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

const toDataUrl = (blob: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Lecture du fichier impossible.')); r.readAsDataURL(blob);
});

/** Ouvre le sélecteur de fichiers du navigateur. */
export function pickBrowserFile(accept = '', multiple = false): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => { resolve(Array.from(input.files ?? [])); input.remove(); };
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

/** Importe des octets dans le vault ; repli data URL si le module fichiers n'est pas disponible. */
export async function importBytesAsMedia(name: string, mime: string, bytes: Uint8Array): Promise<MediaResult> {
  try {
    const f = await files.importBytes(name, mime, bytes);
    return { src: files.url(f), hash: f.hash, name: f.name, mime: f.mime, size: f.size };
  } catch {
    if (bytes.byteLength > MAX_INLINE_BYTES) throw new Error(`« ${name} » est trop volumineux (> 12 Mo) pour être intégré sans la bibliothèque de fichiers.`);
    const src = await toDataUrl(new Blob([bytes as BlobPart], { type: mime }));
    return { src, name, mime, size: bytes.byteLength };
  }
}

export async function importBrowserFile(file: File): Promise<MediaResult> {
  return importBytesAsMedia(file.name, file.type || guessMime(file.name), new Uint8Array(await file.arrayBuffer()));
}

/** Choisit un fichier local (boîte de dialogue native en Tauri) et l'importe. */
export async function chooseLocalMedia(kind: MediaKind): Promise<MediaResult | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const exts = ACCEPT[kind].exts;
    const path = await open({ multiple: false, directory: false, title: `Choisir : ${MEDIA_LABEL[kind].toLowerCase()}`, filters: exts.length ? [{ name: MEDIA_LABEL[kind], extensions: exts }] : undefined });
    if (!path || typeof path !== 'string') return null;
    try {
      const f = await files.importPath(path);
      return { src: files.url(f), hash: f.hash, name: f.name, mime: f.mime, size: f.size };
    } catch {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      return { src: convertFileSrc(path), name: baseName(path), mime: guessMime(path) };
    }
  }
  const [file] = await pickBrowserFile(ACCEPT[kind].accept);
  return file ? importBrowserFile(file) : null;
}

/** URL affichable pour des attributs {src, hash} (le vault prime s'il connaît le fichier). */
export async function resolveMediaSrc(attrs: { src?: string | null; hash?: string | null }): Promise<string> {
  if (attrs.hash) {
    try { const f = await files.get(attrs.hash); if (f) return files.url(f); } catch { /* module fichiers indisponible */ }
  }
  return attrs.src ?? '';
}

/** Ouvre un fichier (vault : panneau / app système ; sinon nouvel onglet). */
export async function openMedia(attrs: { src?: string | null; hash?: string | null }) {
  if (attrs.hash) { try { await files.open(attrs.hash, 'system'); return; } catch { /* repli ci-dessous */ } }
  if (!attrs.src) return;
  if (isTauri && /^https?:/i.test(attrs.src)) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(attrs.src); return; }
  window.open(attrs.src, '_blank', 'noopener');
}
