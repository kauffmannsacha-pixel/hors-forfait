// Connecteur Stripe : clé API restreinte (coffre), bloc « Revenus », base « Paiements Stripe », outil Claude.
import type { ClaudeTool } from '../../ui/registry';
import { setStripeImpl, type Connector } from '../api';
import { promptForKey } from '../core/overlay';
import { connectStripe, disconnectStripe, getStripeKey, getStripeMeta, stripeGet } from './client';
import { StripeRevenue } from './extension';
import { formatMoney, toMajor } from './metrics';
import { invalidateRevenue, loadRevenue } from './revenue';
import { StripeGuide, StripeSettings } from './StripeSettings';
import { syncPayments } from './sync';
import { createElement } from 'react';

const stripeAccount = (m: Awaited<ReturnType<typeof getStripeMeta>>) =>
  m ? [{ id: 'stripe', label: m.label, meta: { livemode: m.livemode, last4: m.last4 } }] : [];

export const stripeRevenueTool: ClaudeTool = {
  name: 'stripe_revenue',
  description: 'Revenus Stripe de l’utilisateur : MRR (abonnements actifs), ventes nettes du jour, nombre d’abonnés actifs, total et détail quotidien des 30 derniers jours. Montants en unités principales (ex. euros).',
  input_schema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'true pour ignorer le cache (10 min).' } } },
  run: async input => {
    const { data, stale } = await loadRevenue(input.refresh === true);
    const cur = data.currency;
    return {
      currency: cur.toUpperCase(), livemode: data.livemode, updatedAt: new Date(data.at).toISOString(), offlineData: stale,
      mrr: data.mrr == null ? null : toMajor(data.mrr, cur), mrrFormatted: data.mrr == null ? 'indisponible' : formatMoney(data.mrr, cur),
      mrrByCurrency: Object.fromEntries(Object.entries(data.mrrByCurrency).map(([c, v]) => [c.toUpperCase(), toMajor(v, c)])),
      activeSubscribers: data.activeSubscribers,
      today: { amount: toMajor(data.today.amount, cur), payments: data.today.count },
      last30Days: { total: toMajor(data.total30, cur), daily: data.series.map(d => ({ date: d.date, amount: toMajor(d.amount, cur), payments: d.count })) },
      warnings: data.warnings,
    };
  },
};

export const stripeConnector: Connector = {
  id: 'stripe',
  name: 'Stripe',
  icon: '💳',
  description: 'Bloc « Revenus » (MRR, ventes, abonnés) et base des paiements synchronisée.',
  auth: {
    type: 'apikey',
    connect: () => promptForKey({
      title: 'Connecter Stripe',
      label: 'Clé API restreinte',
      placeholder: 'rk_live_…',
      guide: createElement(StripeGuide, { defaultOpen: true }),
      validate: async key => {
        const m = await connectStripe(key);
        void syncPayments().catch(() => undefined);
        return stripeAccount(m)[0];
      },
    }),
    disconnect: async () => { await disconnectStripe(); await invalidateRevenue(); },
  },
  accounts: async () => stripeAccount(await getStripeMeta()),
  sync: async () => { await syncPayments(); await loadRevenue(true); },
  syncIntervalMin: 30,
  blocks: [StripeRevenue],
  tools: [stripeRevenueTool],
  settings: StripeSettings,
};

setStripeImpl({
  get: <T,>(path: string, params?: Record<string, string | number>) => stripeGet<T>(path, params ?? {}),
  connected: async () => !!(await getStripeKey()),
  revenue: async opts => (await loadRevenue(opts?.force)).data,
});
