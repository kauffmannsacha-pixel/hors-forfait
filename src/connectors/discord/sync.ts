// Réception Discord : sondage périodique des salons suivis → base « Messages Discord » (dédoublonnée par id).
import { repo } from '../../db/store';
import type { Page, PropertyDef } from '../../db/types';
import { addRow, ensureDatabase, getSchema, rowsOf } from '../../database/api';
import { cmpSnowflake, fetchMessagesAfter, type DiscordMessage } from './client';

export const MESSAGES_DB = 'Messages Discord';
const WATCH_KV = 'connectors:discord:watch';

export interface WatchedChannel { channelId: string; name: string; guild: string; guildId: string; lastId?: string }

export const MESSAGE_PROPS: Omit<PropertyDef, 'id'>[] = [
  { name: 'Nom', type: 'title' },
  { name: 'Contenu', type: 'text' },
  { name: 'Auteur', type: 'text' },
  { name: 'Salon', type: 'text' },
  { name: 'Serveur', type: 'text' },
  { name: 'Date', type: 'date' },
  { name: 'Pièces jointes', type: 'text' },
  { name: 'Lien', type: 'url' },
  { name: 'ID', type: 'text' },
];

export const getWatched = async () => (await repo.kvGet<WatchedChannel[]>(WATCH_KV)) ?? [];
export const setWatched = (list: WatchedChannel[]) => repo.kvSet(WATCH_KV, list);

const USEFUL_TYPES = new Set([0, 19, 20, 21]); // défaut, réponse, commande, message de fil

function messageDoc(m: DiscordMessage) {
  const paras = (m.content || '').split(/\n{2,}/).filter(Boolean).map(t => ({ type: 'paragraph', content: [{ type: 'text', text: t }] }));
  const links = [...(m.attachments ?? []).map(a => ({ href: a.url, label: `📎 ${a.filename}` })), ...(m.embeds ?? []).filter(e => e.url).map(e => ({ href: e.url as string, label: `🔗 ${e.title || e.url}` }))]
    .map(l => ({ type: 'paragraph', content: [{ type: 'text', text: l.label, marks: [{ type: 'link', attrs: { href: l.href } }] }] }));
  const content = [...paras, ...links];
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

export function messageRow(m: DiscordMessage, w: WatchedChannel): Record<string, unknown> {
  const text = m.content || m.embeds?.[0]?.title || m.embeds?.[0]?.description || '';
  const firstLine = text.split('\n')[0].trim();
  return {
    Nom: firstLine ? (firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine) : (m.attachments?.length ? '(pièce jointe)' : '(message sans texte)'),
    Contenu: m.content,
    Auteur: m.author.global_name || m.author.username,
    Salon: `#${w.name}`,
    Serveur: w.guild,
    Date: m.timestamp,
    'Pièces jointes': (m.attachments ?? []).map(a => a.url).join('\n'),
    Lien: `https://discord.com/channels/${w.guildId}/${m.channel_id}/${m.id}`,
    ID: m.id,
  };
}

/** Relève les nouveaux messages des salons suivis (premier passage : les 50 derniers). */
export async function pollDiscord(): Promise<{ added: number }> {
  const watched = await getWatched();
  if (!watched.length) return { added: 0 };
  const dbId = await ensureDatabase(MESSAGES_DB, { icon: '💬', properties: MESSAGE_PROPS });
  const schema = await getSchema(dbId);
  const idP = schema?.properties.find(p => p.name === 'ID')?.id ?? 'ID';
  const known = new Set<string>(rowsOf(dbId).map((r: Page) => String(r.props?.[idP] ?? '')).filter(Boolean));
  let added = 0;
  const next: WatchedChannel[] = [];
  for (const w of watched) {
    const msgs = await fetchMessagesAfter(w.channelId, w.lastId, 50);
    let last = w.lastId;
    for (const m of msgs) {
      if (!last || cmpSnowflake(m.id, last) > 0) last = m.id;
      if (known.has(m.id) || !USEFUL_TYPES.has(m.type)) continue;
      await addRow(dbId, messageRow(m, w), messageDoc(m));
      known.add(m.id); added++;
    }
    next.push({ ...w, lastId: last });
  }
  // Fusion : la liste a pu changer pendant le sondage.
  const cur = await getWatched();
  await setWatched(cur.map(c => ({ ...c, lastId: next.find(n => n.channelId === c.channelId)?.lastId ?? c.lastId })));
  return { added };
}
