// Client Stripe (lecture) : clé API restreinte dans le coffre, pagination, erreurs lisibles.
import { httpFetch } from '../../db/http';
import { secrets } from '../../db/secrets';
import { repo } from '../../db/store';
import { ConnectorError, networkError, withRetry } from '../core/errors';
import { bumpConnectors } from '../core/events';

const API = 'https://api.stripe.com/v1/';
const KEY = 'stripe.api_key';
const META_KV = 'connectors:stripe:meta';

export interface StripeMeta { label: string; livemode: boolean; accountId?: string; addedAt: number; last4: string }

let keyMem: string | null | undefined;
export async function getStripeKey(): Promise<string | null> {
  if (keyMem === undefined) keyMem = (await secrets.get(KEY)) || null;
  return keyMem;
}
export const getStripeMeta = async () => (await repo.kvGet<StripeMeta | null>(META_KV)) ?? null;

export const keyMode = (k: string): 'live' | 'test' | null => (/^(sk|rk)_live_/.test(k) ? 'live' : /^(sk|rk)_test_/.test(k) ? 'test' : null);

/** Noms lisibles des permissions de clé restreinte citées par Stripe (« rak_charge_read »…). */
const PERMS: Record<string, string> = {
  rak_charge_read: 'Charges (lecture)', rak_subscription_read: 'Abonnements (lecture)', rak_customer_read: 'Clients (lecture)',
  rak_balance_read: 'Solde (lecture)', rak_payment_intent_read: 'PaymentIntents (lecture)', rak_invoice_read: 'Factures (lecture)',
  rak_product_read: 'Produits (lecture)', rak_plan_read: 'Plans (lecture)', rak_accounts_kyc_basic_read: 'Compte (lecture)',
};

async function stripeError(r: Response): Promise<ConnectorError> {
  let j: { error?: { type?: string; code?: string; message?: string } } = {};
  try { j = await r.json(); } catch { /* non JSON */ }
  const msg = j.error?.message ?? '';
  const info = { service: 'Stripe', status: r.status, code: j.error?.code };
  if (r.status === 401) return new ConnectorError('Clé Stripe invalide ou révoquée — reconnecte Stripe (Réglages → Connexions).', { ...info, needsReauth: true });
  if (r.status === 403) {
    const perm = /'(rak_[a-z_]+)'/.exec(msg)?.[1];
    return new ConnectorError(`La clé restreinte n’a pas la permission nécessaire${perm ? ` : ajoute « ${PERMS[perm] ?? perm} »` : ''} dans le Dashboard Stripe (Développeurs → Clés API).`, { ...info, code: 'permission' });
  }
  if (r.status === 429) return new ConnectorError('Stripe : trop de requêtes, nouvel essai…', { ...info, retryable: true, retryAfterMs: 1500 });
  if (r.status >= 500) return new ConnectorError(`Stripe indisponible (erreur ${r.status}), nouvel essai…`, { ...info, retryable: true });
  if (r.status === 404) return new ConnectorError('Stripe : ressource introuvable.', info);
  return new ConnectorError(`Stripe : ${msg || 'erreur ' + r.status}`, info);
}

type Params = Record<string, string | number | boolean | undefined>;
export const stripeQuery = (params: Params = {}) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

/** GET sur l'API Stripe (ex. stripeGet('charges', { limit: 10, 'created[gte]': 1700000000 })). */
export async function stripeGet<T = unknown>(path: string, params: Params = {}, keyOverride?: string): Promise<T> {
  const key = keyOverride ?? await getStripeKey();
  if (!key) throw new ConnectorError('Stripe n’est pas connecté — Réglages → Connexions.');
  const qs = stripeQuery(params);
  const url = `${API}${path.replace(/^\/+/, '').replace(/^v1\//, '')}${qs ? `?${qs}` : ''}`;
  return withRetry(async () => {
    let r: Response;
    try { r = await httpFetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }); }
    catch (e) { throw networkError('Stripe', e); }
    if (!r.ok) throw await stripeError(r);
    return r.json() as Promise<T>;
  }, { retries: 3 });
}

/** Liste paginée (starting_after) jusqu'à `maxPages` pages de 100. */
export async function stripeList<T extends { id: string }>(path: string, params: Params = {}, maxPages = 20): Promise<{ data: T[]; truncated: boolean }> {
  const out: T[] = []; let after: string | undefined; let pages = 0;
  for (;;) {
    const j = await stripeGet<{ data: T[]; has_more: boolean }>(path, { limit: 100, ...params, ...(after ? { starting_after: after } : {}) });
    out.push(...j.data);
    pages++;
    if (!j.has_more || !j.data.length) return { data: out, truncated: false };
    if (pages >= maxPages) return { data: out, truncated: true };
    after = j.data[j.data.length - 1].id;
  }
}

/** Vérifie la clé, l'enregistre dans le coffre et mémorise le libellé du compte. */
export async function connectStripe(rawKey: string): Promise<StripeMeta> {
  const key = rawKey.trim();
  const mode = keyMode(key);
  if (!mode) throw new ConnectorError('Une clé Stripe commence par « rk_live_ », « rk_test_ » (clé restreinte, recommandé) ou « sk_… ».');
  if (key.startsWith('pk_')) throw new ConnectorError('C’est une clé publiable : il faut une clé restreinte (rk_…).');
  await stripeGet('charges', { limit: 1 }, key); // permission minimale : Charges (lecture)
  let label = `Stripe ${mode === 'live' ? '' : '(test) '}•••• ${key.slice(-4)}`.replace('  ', ' ');
  let accountId: string | undefined;
  try {
    const acc = await stripeGet<{ id: string; settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string } }>('account', {}, key);
    accountId = acc.id;
    const name = acc.settings?.dashboard?.display_name || acc.business_profile?.name;
    if (name) label = `${name}${mode === 'test' ? ' (test)' : ''}`;
  } catch { /* clé restreinte sans accès au compte : libellé générique */ }
  await secrets.set(KEY, key);
  keyMem = key;
  const meta: StripeMeta = { label, livemode: mode === 'live', accountId, addedAt: Date.now(), last4: key.slice(-4) };
  await repo.kvSet(META_KV, meta);
  bumpConnectors();
  return meta;
}

export async function disconnectStripe() {
  await secrets.del(KEY);
  keyMem = null;
  await repo.kvSet(META_KV, null);
  bumpConnectors();
}

export const dashboardUrl = (meta: StripeMeta | null, path: string) => `https://dashboard.stripe.com/${meta && !meta.livemode ? 'test/' : ''}${path}`;
