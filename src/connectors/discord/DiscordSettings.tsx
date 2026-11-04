// Réglages Discord : invitation du bot, salons suivis (réception → base « Messages Discord »), guide.
import { useEffect, useState } from 'react';
import { Button, Spinner } from '../../ui/kit';
import { openPage, toast } from '../../ui/appState';
import { allPages } from '../../db/pages';
import { errorMessage } from '../core/errors';
import { useConnectorsVersion } from '../core/events';
import { ExternalLink, Guide, InlineError, Toggle, openExternal } from '../core/ui';
import { getDiscordMeta, inviteUrl, listTextChannels, type DiscordChannel, type DiscordMeta } from './client';
import { getWatched, MESSAGES_DB, pollDiscord, setWatched, type WatchedChannel } from './sync';

export function DiscordGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Guide title="Créer le bot Discord" defaultOpen={defaultOpen} steps={[
      <>Ouvre le <ExternalLink href="https://discord.com/developers/applications">Developer Portal</ExternalLink> → <b>New Application</b> (nom : « Prisme »).</>,
      <>Onglet <b>Bot</b> → <b>Reset Token</b> → copie le jeton. Active <b>Message Content Intent</b> pour recevoir le texte des messages des salons suivis.</>,
      <>Colle le jeton ici, puis utilise <b>Inviter le bot</b> pour l’ajouter à ton serveur (permissions : voir les salons, envoyer, intégrer des liens, joindre des fichiers, lire l’historique).</>,
    ]} />
  );
}

export function DiscordSettings() {
  const v = useConnectorsVersion(s => s.v);
  const [meta, setMeta] = useState<DiscordMeta | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[] | null>(null);
  const [watched, setW] = useState<WatchedChannel[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (force = false) => {
    setErr('');
    const m = await getDiscordMeta(); setMeta(m);
    setW(await getWatched());
    if (!m) { setChannels([]); return; }
    try { setChannels(await listTextChannels(force)); } catch (e) { setErr(errorMessage(e)); setChannels([]); }
  };
  useEffect(() => { void load(); }, [v]);

  const toggle = async (c: DiscordChannel, on: boolean) => {
    const cur = await getWatched();
    const next = on ? [...cur.filter(w => w.channelId !== c.id), { channelId: c.id, name: c.name, guild: c.guild, guildId: c.guildId }] : cur.filter(w => w.channelId !== c.id);
    await setWatched(next); setW(next);
  };
  const pollNow = async () => {
    setBusy(true);
    try { const r = await pollDiscord(); toast(`${r.added} nouveau(x) message(s) importé(s).`, 'success'); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  const db = allPages().find(p => p.kind === 'database' && p.title === MESSAGES_DB && !p.trashed);

  if (!meta) return <DiscordGuide />;
  return (
    <div className="cx-stack">
      <div className="cx-row-wrap">
        <Button size="sm" variant="secondary" onClick={() => void openExternal(inviteUrl(meta.botId))}>Inviter le bot sur un serveur ↗</Button>
        <Button size="sm" variant="ghost" onClick={() => void load(true)}>Actualiser les salons</Button>
      </div>
      <div className="cx-subtitle">Salons suivis <span className="cx-hint">— leurs nouveaux messages arrivent dans la base « {MESSAGES_DB} »</span></div>
      {channels === null ? <Spinner /> : channels.length === 0 && !err ? <p className="cx-hint">Aucun salon textuel : invite d’abord le bot sur un serveur.</p> : (
        <div className="cx-toggles cx-scroll">
          {channels.map(c => (
            <Toggle key={c.id} label={`${c.type === 5 ? '📣' : '#'} ${c.name}`} hint={`${c.guild}${c.category ? ' · ' + c.category : ''}`}
              checked={watched.some(w => w.channelId === c.id)} onChange={on => void toggle(c, on)} />
          ))}
        </div>
      )}
      <InlineError>{err}</InlineError>
      {watched.length > 0 && (
        <div className="cx-row-wrap">
          <Button size="sm" variant="primary" loading={busy} onClick={() => void pollNow()}>Relever maintenant</Button>
          {db && <Button size="sm" variant="ghost" onClick={() => openPage(db.id)}>Ouvrir la base</Button>}
        </div>
      )}
    </div>
  );
}
