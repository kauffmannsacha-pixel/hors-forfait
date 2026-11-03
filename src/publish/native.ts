// Pont vers les commandes Rust (src-tauri/src/upload.rs) + boîtes de dialogue / ouverture de liens.
import { isTauri } from '../db/store';

export interface UploadInitResult { uploadUrl: string; total: number; mime: string }
export type UploadStatus = 'incomplete' | 'complete' | 'expired' | 'retry' | 'unauthorized' | 'cancelled';
export interface UploadStep { status: UploadStatus; nextOffset: number; videoId?: string | null; httpStatus: number; retryAfter?: number | null; message?: string | null; uploadStatus?: string | null }
export interface FileInfo { name: string; size: number; mime: string; durationSec?: number | null; width?: number | null; height?: number | null }
export interface UploadProgress { uploadUrl: string; offset: number; sent: number; len: number; total: number }

export const DESKTOP_ONLY = 'La mise en ligne nécessite l’application de bureau Prisme (accès aux fichiers et envoi reprenable).';

async function inv<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  const { invoke } = await import('@tauri-apps/api/core');
  try { return await invoke<T>(cmd, args); }
  catch (e) { throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)); }
}

export const native = {
  uploadInit: (path: string, metadata: unknown, token: string, notifySubscribers: boolean) =>
    inv<UploadInitResult>('yt_upload_init', { path, metadataJson: JSON.stringify(metadata), token, notifySubscribers }),
  uploadChunk: (uploadUrl: string, path: string, offset: number, len: number, total: number, token: string) =>
    inv<UploadStep>('yt_upload_chunk', { uploadUrl, path, offset, len, total, token }),
  uploadStatus: (uploadUrl: string, total: number, token: string) => inv<UploadStep>('yt_upload_status', { uploadUrl, total, token }),
  uploadCancel: (uploadUrl: string) => inv<void>('yt_upload_cancel', { uploadUrl }),
  fileInfo: (path: string) => inv<FileInfo>('yt_file_info', { path }),
  thumbnailSet: (videoId: string, path: string, token: string) => inv<unknown>('yt_thumbnail_set', { videoId, path, token }),
  captionInsert: (videoId: string, path: string, language: string, name: string, isDraft: boolean, token: string) =>
    inv<unknown>('yt_caption_insert', { videoId, path, language, name, isDraft, token }),
};

/** Écoute la progression fine d'un morceau (événement Rust « yt-upload-progress »). */
export async function onUploadProgress(cb: (p: UploadProgress) => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen<UploadProgress>('yt-upload-progress', e => cb(e.payload));
}

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'mts', 'm2ts'];
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** Sélecteur de fichiers natif (plugin dialog). */
export async function pickFiles(kind: 'video' | 'image' | 'srt', multiple = false): Promise<string[]> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  const { open } = await import('@tauri-apps/plugin-dialog');
  const filters = kind === 'video' ? [{ name: 'Vidéos', extensions: VIDEO_EXTENSIONS }]
    : kind === 'image' ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
    : [{ name: 'Sous-titres', extensions: ['srt', 'vtt', 'sbv', 'scc', 'ttml'] }];
  const title = kind === 'video' ? 'Choisir la vidéo à mettre en ligne' : kind === 'image' ? 'Choisir une miniature' : 'Choisir des sous-titres';
  const r = await open({ multiple, directory: false, filters, title });
  if (!r) return [];
  return (Array.isArray(r) ? r : [r]).map(String);
}

/** Ouvre un lien dans le navigateur par défaut. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); }
  else window.open(url, '_blank', 'noopener');
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
