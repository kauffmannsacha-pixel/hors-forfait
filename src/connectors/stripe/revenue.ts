// Instantané des revenus Stripe (MRR, ventes du jour, abonnés actifs, série 30 jours) — cache 10 min, hors-ligne.
import type { RevenueSnapshot } from '../api';
import { sharedCache } from '../core/cache';
import { ConnectorError } from '../core/errors';
import { getStripeKey, keyMode, stripeList } from './client';
import { computeMrr, dailySeries, mainCurrency, salesSince, type StripeCharge, type StripeSubscription } from './metrics';

const CACHE_KEY = 'stripe:revenue';
const TTL = 10 * 60_000;

async function computeRevenue(): Promise<RevenueSnapshot> {
  const key = await getStripeKey();
  if (!key) throw new ConnectorError('Stripe n’est pas connecté — Réglages → Connexions.');
  const warnings: string[] = [];
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const since = new Date(startToday); since.setDate(since.getDate() - 29);

  const [subsRes, chargesRes] = await Promise.all([
    stripeList<StripeSubscription & { id: string }>('subscriptions', { status: 'active' }, 30).then(r => r, (e: unknown) => {
      if (e instanceof ConnectorError && e.info.code === 'permission') { warnings.push('MRR indisponible : ajoute la permission « Abonnements (lecture) » à la clé.'); return null; }
      throw e;
    }),
    stripeList<StripeCharge>('charges', { 'created[gte]': Math.floor(since.getTime() / 1000) }, 50),
  ]);
  const pastDue = subsRes ? await stripeList<StripeSubscription & { id: string }>('subscriptions', { status: 'past_due' }, 5).catch(() => ({ data: [], truncated: false })) : null;
  if (subsRes?.truncated) warnings.push('Plus de 3 000 abonnements : MRR calculé sur les 3 000 premiers.');
  if (chargesRes.truncated) warnings.push('Plus de 5 000 paiements sur 30 jours : graphique partiel.');

  const mrr = subsRes ? computeMrr([...subsRes.data, ...(pastDue?.data ?? [])]) : null;
  const todayByCurrency = salesSince(chargesRes.data, startToday.getTime());
  const currency = mainCurrency(mrr?.byCurrency ?? {}, salesSince(chargesRes.data, since.getTime()));
  const series = dailySeries(chargesRes.data, currency, 30);
  const others = Object.keys({ ...(mrr?.byCurrency ?? {}), ...todayByCurrency }).filter(c => c !== currency);
  if (others.length) warnings.push(`Autres devises non converties : ${others.map(c => c.toUpperCase()).join(', ')}.`);
  return {
    at: Date.now(), currency, livemode: keyMode(key) === 'live',
    mrr: mrr ? mrr.byCurrency[currency] ?? 0 : null, mrrByCurrency: mrr?.byCurrency ?? {},
    activeSubscribers: mrr ? mrr.subscribers : null,
    today: todayByCurrency[currency] ?? { amount: 0, count: 0 }, todayByCurrency,
    series, total30: series.reduce((s, d) => s + d.amount, 0), warnings,
  };
}

/** Revenus (cache 10 min ; hors ligne : dernière valeur connue, `stale`). */
export async function loadRevenue(force = false): Promise<{ data: RevenueSnapshot; stale: boolean }> {
  const r = await sharedCache().wrap(CACHE_KEY, TTL, computeRevenue, { force });
  return { data: r.value, stale: r.stale };
}

export const invalidateRevenue = () => sharedCache().invalidate(CACHE_KEY);
