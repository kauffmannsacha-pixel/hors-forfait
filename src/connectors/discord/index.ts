// Connecteur Discord : jeton de bot, envoi de pages/annonces (confirmation obligatoire), réception dans une base.
import { createElement } from 'react';
import type { ClaudeTool } from '../../ui/registry';
import { confirmAction } from '../../ui/appState';
import { setDiscordImpl, type Connector } from '../api';
import { ConnectorError } from '../core/errors';
import { promptForKey } from '../core/overlay';
import { connectDiscord, disconnectDiscord, getBotToken, getDiscordMeta, listTextChannels, postPayloads, type DiscordChannel } from './client';
import { splitMessage, textToDiscord, type DiscordEmbed } from './convert';
import { DiscordGuide, DiscordSettings } from './DiscordSettings';
import { pollDiscord } from './sync';

const discordAccount = (m: Awaited<ReturnType<typeof getDiscordMeta>>) => (m ? [{ id: m.botId, label: `${m.username} (bot)`, avatar: m.avatar }] : []);

/** Résout un salon par id, « #nom » ou « serveur/#nom ». */
export async function resolveChannel(ref: string): Promise<DiscordChannel> {
  const list = await listTextChannels();
  const r = ref.trim();
  const byId = list.find(c => c.id === r);
  if (byId) return byId;
  const [g, n] = r.includes('/') ? r.split('/', 2) : ['', r];
  const name = n.replace(/^#/, '').toLowerCase();
  const hits = list.filter(c => c.name.toLowerCase() === name && (!g || c.guild.toLowerCase() === g.trim().toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new ConnectorError(`Salon « ${ref} » introuvable. Salons disponibles : ${list.slice(0, 20).map(c => `${c.guild}/#${c.name}`).join(', ')}.`);
  throw new ConnectorError(`Plusieurs salons « ${ref} » : précise le serveur (${hits.map(c => `${c.guild}/#${c.name}`).join(', ')}).`);
}

/** Envoi via le contrat : confirmation sauf si l'appelant l'a déjà obtenue. */
async function send(channelId: string, content: string, opts: { embeds?: unknown[]; confirmed?: boolean } = {}) {
  const ch = (await listTextChannels()).find(c => c.id === channelId);
  if (!opts.confirmed) {
    const ok = await confirmAction(`Envoyer un message dans ${ch ? `#${ch.name} (${ch.guild})` : `le salon ${channelId}`} ?\n\n${content.slice(0, 280)}${content.length > 280 ? '…' : ''}`, { confirmLabel: 'Envoyer' });
    if (!ok) throw new ConnectorError('Envoi Discord annulé.', { cancelled: true });
  }
  const chunks = content ? splitMessage(content) : [];
  const embeds = (opts.embeds ?? []) as DiscordEmbed[];
  const payloads = chunks.map((c, i) => ({ content: c, ...(i === chunks.length - 1 && embeds.length ? { embeds: embeds.slice(0, 10) } : {}) }));
  if (!chunks.length && embeds.length) payloads.push({ content: '', embeds: embeds.slice(0, 10) });
  if (!payloads.length) throw new ConnectorError('Message vide.');
  await postPayloads(channelId, payloads.map(p => (p.content ? p : { embeds: p.embeds })));
}

export const discordSendTool: ClaudeTool = {
  name: 'discord_send',
  description: 'Publie un message dans un salon Discord de l’utilisateur via son bot (annonce, extrait de page…). Action externe : l’utilisateur confirme avant l’envoi. Mentions @everyone/@here/rôles désactivées.',
  external: true,
  input_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Salon : identifiant, « #nom » ou « Serveur/#nom ».' },
      content: { type: 'string', description: 'Texte Markdown Discord (découpé automatiquement au-delà de 2000 caractères).' },
      title: { type: 'string', description: 'Facultatif : publie le texte sous forme de carte (embed) avec ce titre.' },
    },
    required: ['channel', 'content'],
  },
  run: async input => {
    const content = String(input.content ?? '').trim();
    if (!content) throw new Error('Paramètre « content » vide.');
    const ch = await resolveChannel(String(input.channel ?? ''));
    const payloads = textToDiscord(content, input.title ? String(input.title) : undefined);
    const ids = await postPayloads(ch.id, payloads);
    return { ok: true, channel: `#${ch.name}`, guild: ch.guild, messages: ids.length, link: `https://discord.com/channels/${ch.guildId}/${ch.id}/${ids[0]}` };
  },
};

export const discordConnector: Connector = {
  id: 'discord',
  name: 'Discord',
  icon: '💬',
  description: 'Envoie une page ou une annonce dans un salon, et reçoit les messages des salons suivis dans une base.',
  auth: {
    type: 'apikey',
    connect: () => promptForKey({
      title: 'Connecter Discord',
      label: 'Jeton du bot',
      placeholder: 'MTIz…',
      guide: createElement(DiscordGuide, { defaultOpen: true }),
      validate: async token => discordAccount(await connectDiscord(token))[0],
    }),
    disconnect: disconnectDiscord,
  },
  accounts: async () => discordAccount(await getDiscordMeta()),
  sync: async () => { await pollDiscord(); },
  syncIntervalMin: 5,
  tools: [discordSendTool],
  settings: DiscordSettings,
};

setDiscordImpl({
  send,
  channels: async () => ((await getBotToken()) ? (await listTextChannels()).map(c => ({ id: c.id, name: c.name, guild: c.guild })) : []),
});
