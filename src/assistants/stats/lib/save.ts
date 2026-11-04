// Enregistrement d'un fichier exporté : boîte « Enregistrer sous » de Tauri dans l'app, téléchargement dans le navigateur.
import { isTauri } from '../../../db/store';

/** Renvoie le chemin enregistré, 'download' (navigateur) ou null si l'utilisateur annule. */
export async function saveBytes(filename: string, bytes: Uint8Array, mime: string, filterName: string): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const ext = filename.split('.').pop() ?? '';
    const path = await save({ defaultPath: filename, filters: [{ name: filterName, extensions: [ext] }] });
    if (!path) return null;
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return path;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'download';
}
export const saveText = (filename: string, text: string, mime: string, filterName: string) => saveBytes(filename, new TextEncoder().encode(text), mime, filterName);
export async function saveBlob(filename: string, blob: Blob, filterName: string) {
  return saveBytes(filename, new Uint8Array(await blob.arrayBuffer()), blob.type, filterName);
}
