// OAuth 2.0 Google pour application de bureau : redirection sur boucle locale (127.0.0.1:port) + PKCE (S256).
// Serveur local : @fabianlars/tauri-plugin-oauth ; navigateur : @tauri-apps/plugin-opener.
// Doc : developers.google.com/identity/protocols/oauth2/native-app
import { httpFetch } from '../../db/http';
import { isTauri, repo } from '../../db/store';
import { secrets } from '../../db/secrets';
import { createPkce, randomString } from '../core/pkce';
import { ConnectorError, networkError } from '../core/errors';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const CLIENT_ID_KV = 'connectors:google:clientId';
const CLIENT_SECRET_KEY = 'google.client_secret';

export interface GoogleClientConfig { clientId: string; clientSecret: string }
export interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; scope?: string; token_type?: string; id_token?: string }

// ── Identifiants OAuth saisis par l'utilisateur ──────────────
export async function getClientConfig(): Promise<GoogleClientConfig | null> {
  const clientId = ((await repo.kvGet<string>(CLIENT_ID_KV)) ?? '').trim();
  const clientSecret = ((await secrets.get(CLIENT_SECRET_KEY)) ?? '').trim();
  return clientId ? { clientId, clientSecret } : null;
}
export async function clientConfigStatus(): Promise<{ clientId: string; hasSecret: boolean }> {
  return { clientId: (await repo.kvGet<string>(CLIENT_ID_KV)) ?? '', hasSecret: !!(await secrets.get(CLIENT_SECRET_KEY)) };
}
export async function setClientConfig(clientId: string, clientSecret?: string) {
  const id = clientId.trim();
  if (id && !/\.apps\.googleusercontent\.com$/.test(id)) throw new ConnectorError('Le Client ID Google se termine par « .apps.googleusercontent.com ».');
  await repo.kvSet(CLIENT_ID_KV, id);
  if (clientSecret !== undefined && clientSecret.trim()) await secrets.set(CLIENT_SECRET_KEY, clientSecret.trim());
}
export async function clearClientSecret() { await secrets.del(CLIENT_SECRET_KEY); }

// ── URL d'autorisation (pure) ────────────────────────────────
export interface AuthUrlParams { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string; loginHint?: string; prompt?: string }
export function buildAuthUrl(p: AuthUrlParams): string {
  const u = new URL(AUTH_URL);
  const q = u.searchParams;
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('response_type', 'code');
  q.set('scope', [...new Set(p.scopes)].join(' '));
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', p.state);
  q.set('access_type', 'offline');
  // Autorisation incrémentale : Google la documente pour les applis web ; pour les applis installées
  // on redemande de toute façon l'union des scopes (voir accounts.ts), ce paramètre est donc sans risque.
  q.set('include_granted_scopes', 'true');
  q.set('prompt', p.prompt ?? 'consent');
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return u.toString();
}

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'Autorisation refusée dans le navigateur.',
  admin_policy_enforced: 'L’administrateur de ce compte Google bloque cette autorisation.',
  org_internal: 'Ce projet Google Cloud est réservé aux comptes de son organisation (écran de consentement « Interne »).',
  invalid_client: 'Client ID ou secret Google invalide — vérifie-les dans Réglages → Connexions → Google.',
  invalid_grant: 'Code d’autorisation expiré ou déjà utilisé — recommence la connexion.',
  redirect_uri_mismatch: 'L’identifiant OAuth doit être de type « Application de bureau » (Desktop app), pas « Application Web ».',
  unauthorized_client: 'Cet identifiant OAuth n’est pas autorisé pour ce flux — crée un identifiant de type « Application de bureau ».',
  invalid_scope: 'Autorisation demandée invalide (scope) — active l’API correspondante dans ton projet Google Cloud.',
  disallowed_useragent: 'Navigateur non autorisé par Google — ouvre le lien dans Chrome, Edge ou Firefox.',
};
const oauthMessage = (code: string, desc?: string | null) => OAUTH_ERRORS[code] ?? `Google : ${desc || code}`;

/** Extrait le code de l'URL de retour (vérifie `state` contre la CSRF). */
export function parseCallback(url: string, expectedState: string): { code: string } {
  const p = new URL(url).searchParams;
  if (p.get('state') !== expectedState) throw new ConnectorError('Réponse OAuth inattendue (state invalide) — recommence la connexion.');
  const err = p.get('error');
  if (err) throw new ConnectorError(oauthMessage(err, p.get('error_description')), { code: err });
  const code = p.get('code');
  if (!code) throw new ConnectorError('Google n’a renvoyé aucun code d’autorisation.');
  return { code };
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  try {
    return await httpFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString() });
  } catch (e) { throw networkError('Google', e); }
}

async function tokenError(r: Response): Promise<ConnectorError> {
  let j: { error?: string; error_description?: string } = {};
  try { j = await r.json(); } catch { /* corps non JSON */ }
  const code = j.error ?? String(r.status);
  return new ConnectorError(oauthMessage(code, j.error_description), { service: 'Google', status: r.status, code, retryable: r.status >= 500, needsReauth: code === 'invalid_grant' });
}

export async function exchangeCode(cfg: GoogleClientConfig, code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
  const form: Record<string, string> = { code, client_id: cfg.clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri };
  if (cfg.clientSecret) form.client_secret = cfg.clientSecret;
  const r = await postForm(TOKEN_URL, form);
  if (!r.ok) throw await tokenError(r);
  return r.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const cfg = await getClientConfig();
  if (!cfg) throw new ConnectorError('Identifiants OAuth Google manquants — Réglages → Connexions → Google.');
  const form: Record<string, string> = { client_id: cfg.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' };
  if (cfg.clientSecret) form.client_secret = cfg.clientSecret;
  const r = await postForm(TOKEN_URL, form);
  if (!r.ok) {
    const e = await tokenError(r);
    if (e.info.code === 'invalid_grant') e.message = 'Accès Google expiré ou révoqué — reconnecte le compte (Réglages → Connexions).';
    throw e;
  }
  return r.json() as Promise<TokenResponse>;
}

export async function revokeToken(token: string) {
  try { await postForm(REVOKE_URL, { token }); } catch { /* révocation au mieux */ }
}

export async function fetchUserInfo(accessToken: string): Promise<{ sub: string; email?: string; name?: string; picture?: string }> {
  let r: Response;
  try { r = await httpFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } }); } catch (e) { throw networkError('Google', e); }
  if (!r.ok) throw new ConnectorError(`Google : profil illisible (erreur ${r.status}).`);
  return r.json();
}

// ── Page affichée dans le navigateur après la redirection ────
function callbackHtml(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prisme</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 20% 10%,#c9e2ff,transparent),radial-gradient(900px 600px at 90% 90%,#ffd9f1,transparent),#f2f2f7;color:#1d1d1f}
@media (prefers-color-scheme:dark){body{background:radial-gradient(1200px 600px at 20% 10%,#0c2a4d,transparent),radial-gradient(900px 600px at 90% 90%,#3b1030,transparent),#0b0b0f;color:#f5f5f7}.card{background:rgba(32,32,38,.58)!important;border-color:rgba(255,255,255,.09)!important}}
.card{max-width:420px;margin:24px;padding:32px 36px;border-radius:22px;background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.7);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:0 8px 32px rgba(0,0,0,.12);text-align:center;animation:rise .5s cubic-bezier(.2,.9,.3,1)}
.logo{font-size:40px;line-height:1}.t{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;margin:12px 0 6px}.m{opacity:.72;margin:0}
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.98)}}@media (prefers-reduced-motion:reduce){.card{animation:none}}
</style></head><body><main class="card"><div class="logo" id="i">✓</div><div class="t" id="t">Connexion réussie</div><p class="m" id="m">Tu peux fermer cet onglet et revenir dans Prisme.</p></main>
<script>var q=new URLSearchParams(location.search);if(q.get('error')){document.getElementById('i').textContent='✕';document.getElementById('t').textContent='Autorisation refusée';document.getElementById('m').textContent='Aucun accès n’a été accordé. Ferme cet onglet et réessaie depuis Prisme.';}</script></body></html>`;
}

// ── Flux complet ─────────────────────────────────────────────
let lock: Promise<unknown> = Promise.resolve();
let cancelCurrent: (() => void) | null = null;

/** Annule la connexion en cours (bouton « Annuler » pendant l'attente du navigateur). */
export function cancelAuthorize() { cancelCurrent?.(); }

export interface AuthorizeResult { tokens: TokenResponse; granted: string[] }

/**
 * Ouvre le navigateur sur l'écran de consentement Google et attend la redirection locale.
 * Un seul flux à la fois ; délai maximal 5 minutes.
 */
export function authorize(opts: { scopes: string[]; loginHint?: string; prompt?: string; timeoutMs?: number }): Promise<AuthorizeResult> {
  const run = () => authorizeOnce(opts);
  const p = lock.then(run, run);
  lock = p.catch(() => undefined);
  return p;
}

async function authorizeOnce(opts: { scopes: string[]; loginHint?: string; prompt?: string; timeoutMs?: number }): Promise<AuthorizeResult> {
  const cfg = await getClientConfig();
  if (!cfg) throw new ConnectorError('Renseigne d’abord le Client ID (et le secret) OAuth Google : Réglages → Connexions → Google.');
  if (!isTauri) throw new ConnectorError('La connexion Google (OAuth) nécessite l’application de bureau Prisme.');
  const oauth = await import('@fabianlars/tauri-plugin-oauth');
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  const pkce = await createPkce();
  const state = randomString(24);
  const port = await oauth.start({ response: callbackHtml() });
  const redirectUri = `http://127.0.0.1:${port}`;
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    let resolveUrl!: (u: string) => void; let rejectUrl!: (e: Error) => void;
    const urlP = new Promise<string>((res, rej) => { resolveUrl = res; rejectUrl = rej; });
    unlisten = await oauth.onUrl(u => {
      try { if (new URL(u).searchParams.get('state') === state) resolveUrl(u); } catch { /* URL d'un autre flux */ }
    });
    timer = setTimeout(() => rejectUrl(new ConnectorError('Délai dépassé : la connexion Google n’a pas été finalisée dans le navigateur.')), opts.timeoutMs ?? 5 * 60_000);
    cancelCurrent = () => rejectUrl(new ConnectorError('Connexion annulée.', { cancelled: true }));
    await openUrl(buildAuthUrl({ clientId: cfg.clientId, redirectUri, scopes: opts.scopes, state, challenge: pkce.challenge, loginHint: opts.loginHint, prompt: opts.prompt }));
    const url = await urlP;
    finished = true;
    const { code } = parseCallback(url, state);
    const tokens = await exchangeCode(cfg, code, pkce.verifier, redirectUri);
    return { tokens, granted: (tokens.scope ?? '').split(/\s+/).filter(Boolean) };
  } finally {
    cancelCurrent = null;
    if (timer) clearTimeout(timer);
    unlisten?.();
    if (!finished) await oauth.cancel(port).catch(() => undefined);
  }
}
