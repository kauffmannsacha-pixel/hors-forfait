// fetch sans CORS : plugin HTTP de Tauri dans l'app, fetch natif dans le navigateur.
import { isTauri } from './store';
export async function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    const { fetch: tfetch } = await import('@tauri-apps/plugin-http');
    return tfetch(input, init);
  }
  return fetch(input, init);
}
/** Erreur lisible en français à partir d'une réponse HTTP. */
export async function httpError(service: string, r: Response): Promise<Error> {
  let detail = '';
  try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  const map: Record<number, string> = { 401: 'authentification refusée (reconnecte le service)', 403: 'accès interdit ou quota dépassé', 404: 'ressource introuvable', 429: 'trop de requêtes, réessaie dans un instant' };
  return new Error(`${service} : ${map[r.status] ?? 'erreur ' + r.status}${detail ? ' — ' + detail : ''}`);
}
