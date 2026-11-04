// Réglages Stripe : compte connecté, synchro des paiements vers la base, guide de la clé restreinte.
import { useEffect, useState } from 'react';
import { Button } from '../../ui/kit';
import { openPage, toast } from '../../ui/appState';
import { allPages } from '../../db/pages';
import { errorMessage } from '../core/errors';
import { useConnectorsVersion } from '../core/events';
import { ExternalLink, Guide } from '../core/ui';
import { getStripeMeta, type StripeMeta } from './client';
import { invalidateRevenue } from './revenue';
import { PAYMENTS_DB, syncPayments } from './sync';

export function StripeGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Guide title="Créer une clé restreinte (lecture seule)" defaultOpen={defaultOpen} steps={[
      <>Ouvre <ExternalLink href="https://dashboard.stripe.com/apikeys">Dashboard Stripe → Développeurs → Clés API</ExternalLink> puis <b>Créer une clé restreinte</b>.</>,
      <>Donne-lui un nom (« Prisme ») et coche <b>Lecture</b> pour : <b>Charges</b> (paiements), <b>Abonnements</b> (MRR) et, si tu veux le nom du compte, <b>Compte</b>. Tout le reste : <i>Aucun</i>.</>,
      <>Copie la clé <code>rk_live_…</code> (ou <code>rk_test_…</code> pour essayer) et colle-la ici. Elle reste dans le coffre Windows.</>,
    ]} />
  );
}

export function StripeSettings() {
  const v = useConnectorsVersion(s => s.v);
  const [meta, setMeta] = useState<StripeMeta | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getStripeMeta().then(setMeta); }, [v]);
  const db = allPages().find(p => p.kind === 'database' && p.title === PAYMENTS_DB && !p.trashed);
  const sync = async () => {
    setBusy(true);
    try {
      const r = await syncPayments();
      await invalidateRevenue();
      toast(`Paiements synchronisés : ${r.added} ajouté(s), ${r.updated} mis à jour.`, 'success');
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="cx-stack">
      {!meta && <StripeGuide />}
      {meta && (
        <>
          <p className="cx-hint">Les paiements sont importés dans la base <b>« {PAYMENTS_DB} »</b> (dédoublonnés par identifiant, remboursements mis à jour). Insère le bloc <b>/revenus</b> dans n’importe quelle page pour le tableau de bord.</p>
          <div className="cx-row-wrap">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void sync()}>Synchroniser les paiements</Button>
            {db && <Button size="sm" variant="ghost" onClick={() => openPage(db.id)}>Ouvrir la base</Button>}
            <ExternalLink href={`https://dashboard.stripe.com/${meta.livemode ? '' : 'test/'}payments`}>Dashboard Stripe ↗</ExternalLink>
          </div>
        </>
      )}
    </div>
  );
}
