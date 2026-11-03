// Comptes Google (Gmail / Agenda / Drive) : multi-comptes, scopes ajoutés à la demande, appels authentifiés.
import { repo } from '../../db/store';
import { httpFetch } from '../../db/http';
import { toast } from '../../ui/appState';
import { GOOGLE_SCOPES, type ConnectorAccount } from '../api';
import { decodeJwtPayload } from '../core/pkce';
import { ConnectorError, networkError } from '../core/errors';
import { bumpConnectors, setBusy } from '../core/events';
import { sharedCache } from '../core/cache';
import { uniq } from '../core/queue';
import { authorize, fetchUserInfo } from './oauth';
import { OAuthTokenStore } from './tokens';

export interface GoogleAccountMeta { id: string; email: string; name?: string; picture?: string; scopes: string[]; addedAt: number; needsReauth?: boolean }

const KV = 'connectors:google:accounts';

/** Google renvoie « email »/« profile » sous leur forme longue dans `scope`. */
export const normalizeScope = (s: string) =>
  s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s === 'profile' ? 'https://www.googleapis.com/auth/userinfo.profile' : s;
export const hasScopes = (granted: string[], wanted: string[]) => {
  const g = new Set(granted.map(normalizeScope));
  return wanted.every(w => g.has(normalizeScope(w)));
};
export const missingScopes = (granted: string[], wanted: string[]) => {
  const g = new Set(granted.map(normalizeScope));
  return wanted.filter(w => !g.has(normalizeScope(w)));
};

const SERVICE_OF: [string, string][] = [['gmail', 'Gmail'], ['calendar', 'Agenda'], ['drive', 'Drive'], ['youtube', 'YouTube']];
export const servicesOf = (scopes: string[]) => uniq(scopes.flatMap(s => SERVICE_OF.filter(([k]) => s.includes(`/auth/${k}`)).map(([, v]) => v)));

let cachedList: GoogleAccountMeta[] | null = null;
export async function listGoogleAccounts(): Promise<GoogleAccountMeta[]> {
  cachedList ??= (await repo.kvGet<GoogleAccountMeta[]>(KV)) ?? [];
  return cachedList;
}
async function saveAccounts(list: GoogleAccountMeta[]) {
  cachedList = list;
  await repo.kvSet(KV, list);
  bumpConnectors();
}
async function patchAccount(id: string, p: Partial<GoogleAccountMeta>) {
  const list = await listGoogleAccounts();
  await saveAccounts(list.map(a => (a.id === id ? { ...a, ...p } : a)));
}

export const googleTokens = new OAuthTokenStore('google.oauth.', 'Google', id => { void patchAccount(id, { needsReauth: true }); });

export const toGoogleAccount = (a: GoogleAccountMeta): ConnectorAccount => ({
  id: a.id, label: a.email || a.name || 'Compte Google', avatar: a.picture,
  meta: { name: a.name, services: servicesOf(a.scopes), scopes: a.scopes, needsReauth: !!a.needsReauth },
});

/**
 * Connecte (ou reconnecte) un compte Google avec `scopes`.
 * Les applis installées ne garantissant pas l'autorisation incrémentale, on redemande l'union des scopes déjà accordés.
 */
export async function connectGoogle(scopes: string[], opts: { loginHint?: string; expectId?: string } = {}): Promise<GoogleAccountMeta> {
  const list = await listGoogleAccounts();
  const prev = opts.expectId ? list.find(a => a.id === opts.expectId) : undefined;
  const wanted = uniq([...GOOGLE_SCOPES.identity, ...(prev?.scopes ?? []).map(normalizeScope), ...scopes]);
  setBusy('google', 'Termine la connexion dans ton navigateur…');
  try {
    const { tokens, granted } = await authorize({ scopes: wanted, loginHint: opts.loginHint ?? prev?.email, prompt: opts.loginHint || prev ? 'consent' : 'select_account consent' });
    const info = tokens.id_token ? decodeJwtPayload<{ sub: string; email?: string; name?: string; picture?: string }>(tokens.id_token) : await fetchUserInfo(tokens.access_token);
    if (!info.sub) throw new ConnectorError('Google n’a pas renvoyé l’identité du compte.');
    if (opts.expectId && info.sub !== opts.expectId) {
      const exp = list.find(a => a.id === opts.expectId);
      throw new ConnectorError(`Tu as choisi un autre compte Google (${info.email ?? '?'}) — choisis ${exp?.email ?? 'le compte attendu'}.`);
    }
    await googleTokens.save(info.sub, tokens);
    const cur = (await listGoogleAccounts()).find(a => a.id === info.sub);
    const meta: GoogleAccountMeta = {
      id: info.sub, email: info.email ?? cur?.email ?? '', name: info.name ?? cur?.name, picture: info.picture ?? cur?.picture,
      scopes: granted.map(normalizeScope), addedAt: cur?.addedAt ?? Date.now(), needsReauth: false,
    };
    const others = (await listGoogleAccounts()).filter(a => a.id !== meta.id);
    await saveAccounts([...others, meta]);
    const missing = missingScopes(meta.scopes, scopes);
    if (missing.length) toast(`Certaines autorisations n’ont pas été accordées (${servicesOf(missing).join(', ') || missing.length + ' scope(s)'}) : les fonctions liées resteront indisponibles.`, 'warning');
    return meta;
  } finally { setBusy('google'); }
}

/** Garantit que le compte dispose de `scopes` (consentement supplémentaire si besoin). */
export async function ensureGoogleScopes(accountId: string, scopes: string[], interactive = true): Promise<void> {
  const acc = (await listGoogleAccounts()).find(a => a.id === accountId);
  if (!acc) throw new ConnectorError('Compte Google introuvable — Réglages → Connexions.');
  if (!acc.needsReauth && hasScopes(acc.scopes, scopes)) return;
  // En arrière-plan on n'ouvre jamais le navigateur : l'utilisateur reconnectera depuis les réglages.
  if (!interactive) throw new ConnectorError(`${acc.email} : autorisation Google requise — reconnecte le compte (Réglages → Connexions).`, { needsReauth: true });
  toast(`Autorisation supplémentaire demandée pour ${acc.email} : termine dans ton navigateur.`, 'info');
  const meta = await connectGoogle(scopes, { loginHint: acc.email, expectId: acc.id });
  const missing = missingScopes(meta.scopes, scopes);
  if (missing.length) throw new ConnectorError(`Autorisation refusée pour : ${servicesOf(missing).join(', ') || missing.join(', ')}.`);
}

export async function getGoogleToken(accountId: string, scopes: string[] = [], interactive = true): Promise<string> {
  if (scopes.length) await ensureGoogleScopes(accountId, scopes, interactive);
  return googleTokens.accessToken(accountId);
}

export async function disconnectGoogle(accountId: string) {
  // Pas de révocation côté Google : elle retirerait aussi l'accès des autres connexions du même compte
  // (ex. la chaîne YouTube principale). Les jetons sont effacés du coffre.
  await googleTokens.remove(accountId, false);
  await saveAccounts((await listGoogleAccounts()).filter(a => a.id !== accountId));
  await sharedCache().invalidate(`g:${accountId}:`);
}

/** Premier compte disposant déjà de `scopes` (sinon le premier compte). */
export async function pickAccount(scopes: string[]): Promise<GoogleAccountMeta | undefined> {
  const list = await listGoogleAccounts();
  return list.find(a => hasScopes(a.scopes, scopes)) ?? list[0];
}

// ── Erreurs des API Google ───────────────────────────────────
interface GErr { error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[]; details?: { reason?: string }[] } }

export async function googleApiError(service: string, r: Response): Promise<ConnectorError> {
  let j: GErr = {};
  try { j = await r.json(); } catch { /* non JSON */ }
  const reason = j.error?.errors?.[0]?.reason ?? j.error?.details?.[0]?.reason ?? j.error?.status ?? '';
  const msg = j.error?.message ?? '';
  const link = /https:\/\/console\.(developers|cloud)\.google\.com\/[^\s"')]+/.exec(msg)?.[0];
  const info = { service, status: r.status, code: reason };
  if (/accessNotConfigured|SERVICE_DISABLED/.test(reason) || /has not been used|is disabled/.test(msg))
    return new ConnectorError(`${service} : l’API n’est pas activée dans ton projet Google Cloud${link ? ` — active-la ici : ${link}` : ''}.`, info);
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/.test(reason) && r.status === 403)
    return new ConnectorError(`${service} : autorisation insuffisante — reconnecte le compte en acceptant toutes les cases.`, { ...info, needsReauth: true });
  if (/rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/.test(reason) || r.status === 429)
    return new ConnectorError(`${service} : trop de requêtes, nouvel essai…`, { ...info, retryable: true, retryAfterMs: 2000 });
  if (r.status === 401) return new ConnectorError(`${service} : session expirée — reconnecte le compte.`, { ...info, needsReauth: true });
  if (r.status === 404) return new ConnectorError(`${service} : élément introuvable.`, info);
  if (r.status >= 500) return new ConnectorError(`${service} indisponible (erreur ${r.status}), nouvel essai…`, { ...info, retryable: true });
  return new ConnectorError(`${service} : ${msg || 'erreur ' + r.status}`, info);
}

/** fetch authentifié sur une API Google (réessaie une fois après un 401 avec un jeton rafraîchi). */
export async function googleFetch(accountId: string, scopes: string[], url: string, init: RequestInit = {}, service = 'Google', interactive = true): Promise<Response> {
  const go = async (token: string) => {
    try { return await httpFetch(url, { ...init, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } }); }
    catch (e) { throw networkError(service, e); }
  };
  let r = await go(await getGoogleToken(accountId, scopes, interactive));
  if (r.status === 401) { googleTokens.invalidate(accountId); r = await go(await getGoogleToken(accountId, scopes, interactive)); }
  if (!r.ok) throw await googleApiError(service, r);
  return r;
}
