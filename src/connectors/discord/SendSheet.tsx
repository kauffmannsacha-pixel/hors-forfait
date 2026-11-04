// « Envoyer la page dans un salon Discord » : choix du salon, format (message / embed), aperçu, confirmation obligatoire.
import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Field, Select, Spinner, Tabs } from '../../ui/kit';
import { confirmAction, currentPageId, navigate, toast } from '../../ui/appState';
import { getPage } from '../../db/pages';
import { repo } from '../../db/store';
import { getActiveEditor } from '../../editor/active';
import { errorMessage } from '../core/errors';
import { InlineError } from '../core/ui';
import { openSheet } from '../core/overlay';
import { getBotToken, listTextChannels, postPayloads, type DiscordChannel } from './client';
import { pageToDiscord, type PageLike } from './convert';

const LAST_KV = 'connectors:discord:lastChannel';

/** Page courante (contenu de l'éditeur ouvert s'il correspond, sinon contenu enregistré). */
export function currentPageLike(): (PageLike & { id: string }) | null {
  const active = getActiveEditor();
  const id = active?.pageId ?? currentPageId();
  if (!id) return null;
  const p = getPage(id);
  if (!p) return null;
  const content = active && active.pageId === id && !active.editor.isDestroyed ? active.editor.getJSON() : p.content;
  return { id, title: p.title, icon: p.icon, content };
}

function SendSheet({ page, close }: { page: PageLike & { id: string }; close: () => void }) {
  const [channels, setChannels] = useState<DiscordChannel[] | null>(null);
  const [channelId, setChannelId] = useState('');
  const [mode, setMode] = useState<'message' | 'embed'>('embed');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        if (!(await getBotToken())) { setChannels([]); return; }
        const list = await listTextChannels();
        setChannels(list);
        const last = await repo.kvGet<string>(LAST_KV);
        setChannelId(list.find(c => c.id === last)?.id ?? list[0]?.id ?? '');
      } catch (e) { setErr(errorMessage(e)); setChannels([]); }
    })();
  }, []);

  const payloads = useMemo(() => pageToDiscord(page, { mode, footer: 'Envoyé depuis Prisme', timestamp: new Date().toISOString() }), [page, mode]);
  const channel = channels?.find(c => c.id === channelId);
  const guilds = useMemo(() => [...new Set((channels ?? []).map(c => c.guild))], [channels]);

  const send = async () => {
    if (!channel) return;
    const ok = await confirmAction(`Envoyer « ${page.title || 'Sans titre'} » dans #${channel.name} (${channel.guild}) ? ${payloads.length} message${payloads.length > 1 ? 's seront publiés' : ' sera publié'}, visible${payloads.length > 1 ? 's' : ''} par les membres du salon.`, { confirmLabel: 'Envoyer' });
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      await postPayloads(channel.id, payloads);
      await repo.kvSet(LAST_KV, channel.id);
      toast(`Page envoyée dans #${channel.name}.`, 'success');
      close();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  if (channels === null) return <div className="cx-center"><Spinner /></div>;
  if (!channels.length) return (
    <Empty icon="💬" title={err ? 'Salons indisponibles' : 'Discord n’est pas connecté'}>
      {err ? <InlineError>{err}</InlineError> : 'Ajoute le jeton de ton bot puis invite-le sur ton serveur.'}
      <div className="cx-actions cx-center"><Button variant="primary" onClick={() => { close(); navigate({ type: 'settings', panel: 'connexions' }); }}>Ouvrir Réglages → Connexions</Button></div>
    </Empty>
  );
  return (
    <div className="cx-stack">
      <div className="cx-grid-2">
        <Field label="Salon">
          <Select value={channelId} onChange={e => setChannelId(e.target.value)}>
            {guilds.map(g => (
              <optgroup key={g} label={g}>
                {channels.filter(c => c.guild === g).map(c => <option key={c.id} value={c.id}>{c.type === 5 ? '📣' : '#'} {c.name}{c.category ? ` · ${c.category}` : ''}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="Format">
          <Tabs value={mode} onChange={setMode} tabs={[{ id: 'embed', label: 'Carte (embed)' }, { id: 'message', label: 'Message' }]} />
        </Field>
      </div>
      <div className="cx-subtitle">Aperçu <span className="cx-hint">— {payloads.length} message{payloads.length > 1 ? 's' : ''}, mentions désactivées</span></div>
      <div className="cx-discord-preview">
        {payloads.map((p, i) => (
          <div key={i} className="cx-discord-msg">
            {p.content && <pre className="cx-discord-text">{p.content}</pre>}
            {p.embeds?.map((e, j) => (
              <div key={j} className="cx-discord-embed" style={{ borderLeftColor: `#${(e.color ?? 0x0a84ff).toString(16).padStart(6, '0')}` }}>
                {e.title && <div className="cx-discord-embed-title">{e.title}</div>}
                {e.description && <pre className="cx-discord-text">{e.description}</pre>}
                {e.footer && <div className="cx-hint">{e.footer.text}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <InlineError>{err}</InlineError>
      <div className="cx-actions">
        <Button variant="ghost" onClick={close}>Annuler</Button>
        <Button variant="primary" loading={busy} disabled={!channel} onClick={() => void send()}>Envoyer…</Button>
      </div>
    </div>
  );
}

/** Ouvre la feuille d'envoi pour la page courante. */
export async function openDiscordSend() {
  const page = currentPageLike();
  if (!page) { toast('Ouvre d’abord la page à envoyer.', 'warning'); return; }
  await openSheet<void>('Envoyer la page dans Discord', close => <SendSheet page={page} close={() => close()} />, 640);
}
