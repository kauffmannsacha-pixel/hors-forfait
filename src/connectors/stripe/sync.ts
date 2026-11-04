// Synchro des paiements Stripe → base « Paiements Stripe » (dédoublonnage par id de charge, mise à jour des remboursements).
import { repo } from '../../db/store';
import type { Page, PropertyDef } from '../../db/types';
import { addRow, ensureDatabase, getSchema, rowsOf, updateRow } from '../../database/api';
import { dashboardUrl, getStripeMeta, stripeList } from './client';
import { chargeStatus, netAmount, toMajor, type StripeCharge } from './metrics';

export const PAYMENTS_DB = 'Paiements Stripe';
const CURSOR_KV = 'connectors:stripe:cursor';

const opt = (name: string, color: string) => ({ id: '', name, color });
export const PAYMENT_PROPS: Omit<PropertyDef, 'id'>[] = [
  { name: 'Nom', type: 'title' },
  { name: 'Montant', type: 'number', numberFormat: 'number' },
  { name: 'Net', type: 'number', numberFormat: 'number' },
  { name: 'Devise', type: 'text' },
  { name: 'Statut', type: 'select', options: [opt('Réussi', 'green'), opt('Remboursé partiellement', 'orange'), opt('Remboursé', 'gray'), opt('Échoué', 'red'), opt('En attente', 'yellow')] },
  { name: 'Client', type: 'text' },
  { name: 'E-mail', type: 'email' },
  { name: 'Date', type: 'date' },
  { name: 'ID', type: 'text' },
  { name: 'Paiement', type: 'text' },
  { name: 'Lien', type: 'url' },
];

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? '' : typeof v === 'string' ? v : v.id);

/** Valeurs de ligne (par nom de propriété ; select = nom de l'option, date = ISO 8601). */
export function chargeRow(c: StripeCharge, livemodeDashboard: Parameters<typeof dashboardUrl>[0]): Record<string, unknown> {
  const email = c.billing_details?.email || c.receipt_email || (typeof c.customer === 'object' && c.customer ? c.customer.email : '') || '';
  const name = c.billing_details?.name || (typeof c.customer === 'object' && c.customer ? c.customer.name : '') || '';
  const pi = idOf(c.payment_intent);
  return {
    Nom: c.description || c.calculated_statement_descriptor || `Paiement ${name || email || c.id}`,
    Montant: toMajor(c.amount, c.currency),
    Net: toMajor(netAmount(c), c.currency),
    Devise: c.currency.toUpperCase(),
    Statut: chargeStatus(c),
    Client: name,
    'E-mail': email,
    Date: new Date(c.created * 1000).toISOString(),
    ID: c.id,
    Paiement: pi,
    Lien: dashboardUrl(livemodeDashboard, `payments/${pi || c.id}`),
  };
}

/** Importe les paiements récents (90 jours au premier passage, puis depuis le dernier curseur − 3 jours). */
export async function syncPayments(): Promise<{ added: number; updated: number; dbId: string }> {
  const dbId = await ensureDatabase(PAYMENTS_DB, { icon: '💳', properties: PAYMENT_PROPS });
  const schema = await getSchema(dbId);
  const pid = (name: string) => schema?.properties.find(p => p.name === name)?.id ?? name;
  const [idP, statusP, netP] = [pid('ID'), pid('Statut'), pid('Net')];
  const existing = new Map<string, Page>();
  for (const row of rowsOf(dbId)) { const v = row.props?.[idP]; if (typeof v === 'string' && v) existing.set(v, row); }

  const cursor = await repo.kvGet<number>(CURSOR_KV);
  const since = cursor ? cursor - 3 * 86_400 : Math.floor(Date.now() / 1000) - 90 * 86_400;
  const { data } = await stripeList<StripeCharge>('charges', { 'created[gte]': since }, cursor ? 20 : 40);
  const meta = await getStripeMeta();
  let added = 0; let updated = 0; let max = cursor ?? 0;
  for (const c of [...data].sort((a, b) => a.created - b.created)) {
    max = Math.max(max, c.created);
    const values = chargeRow(c, meta);
    const row = existing.get(c.id);
    if (!row) {
      existing.set(c.id, await addRow(dbId, values));
      added++;
    } else if (row.props?.[statusP] !== values.Statut || row.props?.[netP] !== values.Net) {
      await updateRow(row.id, { Statut: values.Statut, Net: values.Net });
      updated++;
    }
  }
  await repo.kvSet(CURSOR_KV, max);
  return { added, updated, dbId };
}

export const resetPaymentsCursor = () => repo.kvSet(CURSOR_KV, null);
