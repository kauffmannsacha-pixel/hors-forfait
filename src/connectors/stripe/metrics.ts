// Calculs de revenus Stripe (purs, testés) : MRR, ventes du jour, série 30 jours, formats monétaires.
import { localDayKey } from '../core/format';

export const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export const toMajor = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? minor : minor / 100);

export function formatMoney(minor: number, currency: string, opts: { compact?: boolean } = {}): string {
  const cur = (currency || 'eur').toUpperCase();
  const major = toMajor(minor, cur);
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency', currency: cur, ...(opts.compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: ZERO_DECIMAL.has(cur.toLowerCase()) ? 0 : 2 }),
    }).format(major);
  } catch { return `${major.toLocaleString('fr-FR')} ${cur}`; }
}

export interface StripeRecurring { interval: 'day' | 'week' | 'month' | 'year'; interval_count?: number | null }
export interface StripePrice { unit_amount?: number | null; unit_amount_decimal?: string | null; currency: string; recurring?: StripeRecurring | null }
export interface StripeSubItem { price?: StripePrice | null; plan?: { amount?: number | null; amount_decimal?: string | null; currency: string; interval: StripeRecurring['interval']; interval_count?: number | null } | null; quantity?: number | null }
export interface StripeCoupon { percent_off?: number | null; amount_off?: number | null; currency?: string | null; duration?: string }
export interface StripeSubscription {
  id: string; status: string; customer: string | { id: string }; currency?: string;
  items: { data: StripeSubItem[] };
  discount?: { coupon?: StripeCoupon | null } | null;
  discounts?: (string | { coupon?: StripeCoupon | null })[] | null;
}
export interface StripeCharge {
  id: string; amount: number; amount_refunded?: number; currency: string; created: number; status: 'succeeded' | 'pending' | 'failed' | string;
  paid?: boolean; refunded?: boolean; description?: string | null; receipt_email?: string | null;
  billing_details?: { email?: string | null; name?: string | null } | null;
  customer?: string | { id: string; email?: string | null; name?: string | null } | null;
  payment_intent?: string | { id: string } | null; receipt_url?: string | null; livemode?: boolean;
  failure_message?: string | null; calculated_statement_descriptor?: string | null;
}

const MONTHLY_FACTOR: Record<StripeRecurring['interval'], number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

/** Montant mensuel (unités mineures) d'une ligne d'abonnement. */
export function itemMonthly(item: StripeSubItem): { amount: number; currency: string } | null {
  const qty = item.quantity ?? 1;
  const p = item.price;
  if (p?.recurring) {
    const unit = p.unit_amount ?? (p.unit_amount_decimal ? Number(p.unit_amount_decimal) : null);
    if (unit == null || !Number.isFinite(unit)) return null; // tarification par paliers / à l'usage : non estimable
    const count = p.recurring.interval_count || 1;
    return { amount: (unit * qty * MONTHLY_FACTOR[p.recurring.interval]) / count, currency: p.currency.toLowerCase() };
  }
  const pl = item.plan;
  if (pl) {
    const unit = pl.amount ?? (pl.amount_decimal ? Number(pl.amount_decimal) : null);
    if (unit == null || !Number.isFinite(unit)) return null;
    return { amount: (unit * qty * MONTHLY_FACTOR[pl.interval]) / (pl.interval_count || 1), currency: pl.currency.toLowerCase() };
  }
  return null;
}

/** Remise permanente/répétée appliquée au MRR (pourcentage ou montant fixe, dans la devise de l'abonnement). */
function applyDiscount(amount: number, currency: string, sub: StripeSubscription): number {
  const coupons = [sub.discount?.coupon, ...(sub.discounts ?? []).map(d => (typeof d === 'string' ? null : d.coupon))].filter((c): c is StripeCoupon => !!c && c.duration !== 'once');
  let a = amount;
  for (const c of coupons) {
    if (c.percent_off) a *= 1 - c.percent_off / 100;
    else if (c.amount_off && (!c.currency || c.currency.toLowerCase() === currency)) a -= c.amount_off;
  }
  return Math.max(0, a);
}

const ACTIVE = new Set(['active', 'past_due']);

/** MRR par devise + nombre d'abonnés (clients distincts) pour les abonnements actifs (et en retard de paiement). */
export function computeMrr(subs: StripeSubscription[]): { byCurrency: Record<string, number>; subscribers: number; subscriptions: number } {
  const byCurrency: Record<string, number> = {};
  const customers = new Set<string>();
  let n = 0;
  for (const s of subs) {
    if (!ACTIVE.has(s.status)) continue;
    n++;
    customers.add(typeof s.customer === 'string' ? s.customer : s.customer.id);
    const perCur: Record<string, number> = {};
    for (const it of s.items?.data ?? []) {
      const m = itemMonthly(it);
      if (m) perCur[m.currency] = (perCur[m.currency] ?? 0) + m.amount;
    }
    for (const [cur, amt] of Object.entries(perCur)) byCurrency[cur] = (byCurrency[cur] ?? 0) + applyDiscount(amt, cur, s);
  }
  for (const k of Object.keys(byCurrency)) byCurrency[k] = Math.round(byCurrency[k]);
  return { byCurrency, subscribers: customers.size, subscriptions: n };
}

/** Montant net encaissé d'un paiement (réussi, moins les remboursements). */
export const netAmount = (c: StripeCharge) => (c.status === 'succeeded' && c.paid !== false ? c.amount - (c.amount_refunded ?? 0) : 0);

/** Ventes (nettes) depuis `sinceMs`, par devise. */
export function salesSince(charges: StripeCharge[], sinceMs: number): Record<string, { amount: number; count: number }> {
  const out: Record<string, { amount: number; count: number }> = {};
  for (const c of charges) {
    if (c.created * 1000 < sinceMs || c.status !== 'succeeded' || c.paid === false) continue;
    const cur = c.currency.toLowerCase();
    const o = (out[cur] ??= { amount: 0, count: 0 });
    o.amount += netAmount(c); o.count++;
  }
  return out;
}

/** Série quotidienne (jours locaux) des ventes nettes dans `currency`, sur `days` jours se terminant aujourd'hui. */
export function dailySeries(charges: StripeCharge[], currency: string, days: number, now: number = Date.now()): { date: string; amount: number; count: number }[] {
  const end = new Date(now); end.setHours(0, 0, 0, 0);
  const series: { date: string; amount: number; count: number }[] = [];
  const idx = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const k = localDayKey(d);
    idx.set(k, series.length);
    series.push({ date: k, amount: 0, count: 0 });
  }
  const cur = currency.toLowerCase();
  for (const c of charges) {
    if (c.currency.toLowerCase() !== cur || c.status !== 'succeeded' || c.paid === false) continue;
    const i = idx.get(localDayKey(c.created * 1000));
    if (i === undefined) continue;
    series[i].amount += netAmount(c); series[i].count++;
  }
  return series;
}

/** Devise principale : celle du plus gros volume (MRR puis ventes), EUR par défaut. */
export function mainCurrency(...maps: Record<string, number | { amount: number }>[]): string {
  const tot: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) tot[k] = (tot[k] ?? 0) + (typeof v === 'number' ? v : v.amount);
  return Object.entries(tot).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'eur';
}

/** Statut lisible d'un paiement (valeurs de la propriété « Statut » de la base). */
export function chargeStatus(c: StripeCharge): 'Réussi' | 'Remboursé' | 'Remboursé partiellement' | 'Échoué' | 'En attente' {
  if (c.status === 'failed') return 'Échoué';
  if (c.status === 'pending') return 'En attente';
  if (c.refunded || (c.amount_refunded ?? 0) >= c.amount) return 'Remboursé';
  if ((c.amount_refunded ?? 0) > 0) return 'Remboursé partiellement';
  return 'Réussi';
}
