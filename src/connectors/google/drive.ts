// Google Drive API v3 : recherche, téléchargement / export, épinglage dans la page courante.
import { GOOGLE_SCOPES } from '../api';
import { files, FILE_PIN_NODE } from '../../files/api';
import { getActiveEditor } from '../../editor/active';
import type { VaultFile } from '../../db/types';
import { ConnectorError, withRetry } from '../core/errors';
import { googleFetch } from './accounts';

const API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_SCOPES = GOOGLE_SCOPES.drive;
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

export interface DriveFile {
  id: string; name: string; mimeType: string; size?: number; modifiedTime?: string;
  iconLink?: string; thumbnailLink?: string; webViewLink?: string; ownerName?: string;
}

/** Formats d'export des fichiers Google (Docs, Sheets…) — limite Google : 10 Mo. */
export const EXPORTS: Record<string, { mime: string; ext: string; label: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf', label: 'Google Docs → PDF' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', label: 'Google Sheets → Excel' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf', label: 'Google Slides → PDF' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png', label: 'Google Drawings → PNG' },
};
export const isFolder = (f: DriveFile) => f.mimeType === 'application/vnd.google-apps.folder';
export const isGoogleNative = (f: DriveFile) => f.mimeType.startsWith('application/vnd.google-apps.');
export const canPin = (f: DriveFile) => !isFolder(f) && (!isGoogleNative(f) || !!EXPORTS[f.mimeType]);

/** Échappe une valeur pour la syntaxe de requête Drive (`name contains '…'`). */
export const escapeDriveQuery = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function buildDriveQuery(text: string, mode: 'name' | 'fullText' = 'name'): string {
  const t = text.trim();
  const parts = ['trashed = false', "mimeType != 'application/vnd.google-apps.folder'"];
  if (t) parts.push(`${mode === 'fullText' ? 'fullText' : 'name'} contains '${escapeDriveQuery(t)}'`);
  return parts.join(' and ');
}

interface RawFile { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; iconLink?: string; thumbnailLink?: string; webViewLink?: string; owners?: { displayName?: string }[] }

export async function searchDrive(accountId: string, text: string, opts: { mode?: 'name' | 'fullText'; pageToken?: string; pageSize?: number } = {}): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const qs = new URLSearchParams({
    q: buildDriveQuery(text, opts.mode),
    pageSize: String(opts.pageSize ?? 30),
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,owners(displayName))',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives',
  });
  if (opts.mode !== 'fullText') qs.set('orderBy', text.trim() ? 'modifiedTime desc,name' : 'viewedByMeTime desc,modifiedTime desc');
  if (opts.pageToken) qs.set('pageToken', opts.pageToken);
  const r = await withRetry(() => googleFetch(accountId, DRIVE_SCOPES, `${API}/files?${qs}`, {}, 'Google Drive'));
  const j = await r.json() as { files?: RawFile[]; nextPageToken?: string };
  return {
    files: (j.files ?? []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size ? Number(f.size) : undefined, modifiedTime: f.modifiedTime, iconLink: f.iconLink, thumbnailLink: f.thumbnailLink, webViewLink: f.webViewLink, ownerName: f.owners?.[0]?.displayName })),
    nextPageToken: j.nextPageToken,
  };
}

/** Télécharge le contenu (export pour les fichiers Google natifs). */
export async function downloadDriveFile(accountId: string, f: DriveFile): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  if (isFolder(f)) throw new ConnectorError('Un dossier ne peut pas être épinglé.');
  if (f.size && f.size > MAX_DOWNLOAD_BYTES) throw new ConnectorError(`Fichier trop volumineux (${Math.round(f.size / 1048576)} Mo, limite 500 Mo).`);
  const exp = EXPORTS[f.mimeType];
  if (isGoogleNative(f) && !exp) throw new ConnectorError('Ce type de fichier Google ne peut pas être exporté.');
  const url = exp
    ? `${API}/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`
    : `${API}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
  const r = await googleFetch(accountId, DRIVE_SCOPES, url, { headers: { Accept: '*/*' } }, 'Google Drive');
  const bytes = new Uint8Array(await r.arrayBuffer());
  const name = exp && !f.name.toLowerCase().endsWith('.' + exp.ext) ? `${f.name}.${exp.ext}` : f.name;
  return { name, mime: exp?.mime ?? (f.mimeType || 'application/octet-stream'), bytes };
}

/** Télécharge le fichier, l'importe dans le vault et l'épingle (nœud filePin) dans l'éditeur actif. */
export async function pinDriveFile(accountId: string, f: DriveFile): Promise<VaultFile> {
  const active = getActiveEditor();
  if (!active) throw new ConnectorError('Ouvre une page (curseur dans le texte) pour y épingler le fichier.');
  const { name, mime, bytes } = await downloadDriveFile(accountId, f);
  const vf = await files.importBytes(name, mime, bytes);
  const ed = getActiveEditor()?.editor ?? active.editor;
  if (ed.isDestroyed) throw new ConnectorError('La page a été fermée pendant le téléchargement : le fichier est dans la bibliothèque (onglet Fichiers).');
  ed.chain().focus().insertContent([{ type: FILE_PIN_NODE, attrs: { hash: vf.hash, name: vf.name, mime: vf.mime } }, { type: 'text', text: ' ' }]).run();
  return vf;
}
