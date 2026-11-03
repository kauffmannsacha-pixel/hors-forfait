// Connecteur Google (Gmail / Agenda / Drive) : OAuth bureau (boucle locale + PKCE), multi-comptes.
import { setGoogleImpl, type Connector } from '../api';
import { ConnectorError } from '../core/errors';
import { connectGoogle, disconnectGoogle, getGoogleToken, listGoogleAccounts, toGoogleAccount } from './accounts';
import { calendarAccounts, listCalendars, listEvents } from './calendar';
import { GoogleSettings, openGoogleConnect } from './GoogleSettings';

/** Synchro : préchargement des agendas et des événements (−7 j → +60 j) pour la lecture hors-ligne. */
async function syncGoogle() {
  const from = new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Date.now() + 60 * 86_400_000);
  from.setHours(0, 0, 0, 0); to.setHours(0, 0, 0, 0);
  for (const a of await calendarAccounts()) {
    if (a.needsReauth) continue;
    const cals = await listCalendars(a.id, true);
    for (const c of cals.filter(x => x.selected)) await listEvents(a.id, c.id, from, to, true);
  }
}

export const googleConnector: Connector = {
  id: 'google',
  name: 'Google',
  icon: '🗓️',
  description: 'Agenda, Drive et Gmail — plusieurs comptes, autorisations ajoutées à la demande.',
  auth: {
    type: 'oauth',
    connect: async () => {
      const meta = await openGoogleConnect();
      if (!meta) throw new ConnectorError('Connexion annulée.', { cancelled: true });
      return toGoogleAccount(meta);
    },
    disconnect: disconnectGoogle,
  },
  accounts: async () => (await listGoogleAccounts()).map(toGoogleAccount),
  sync: syncGoogle,
  syncIntervalMin: 15,
  settings: GoogleSettings,
};

setGoogleImpl({
  accounts: async () => (await listGoogleAccounts()).map(toGoogleAccount),
  token: (accountId, scopes) => getGoogleToken(accountId, scopes ?? []),
  connect: async scopes => toGoogleAccount(await connectGoogle(scopes ?? [])),
});
