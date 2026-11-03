// Page Prisme → message(s) Discord. Limites officielles : contenu 2000 caractères ; embeds : 10 par message,
// titre 256, description 4096, pied 2048, total 6000 caractères par message. Logique pure, testée.
import { docToMarkdown, firstImageUrl } from '../core/markdown';

export interface DiscordEmbed {
  title?: string; description?: string; url?: string; color?: number; timestamp?: string;
  footer?: { text: string }; author?: { name: string }; image?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}
export interface DiscordPayload { content?: string; embeds?: DiscordEmbed[] }

export const LIMITS = { content: 2000, title: 256, description: 4096, footer: 2048, embeds: 10, total: 6000 } as const;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const FENCE = /^\s*```/;

/** Découpe en blocs (séparés par une ligne vide) sans jamais couper un bloc de code. */
function splitBlocks(text: string): string[] {
  const out: string[] = []; let cur: string[] = []; let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '' && !FENCE.test(line)) { if (cur.length) out.push(cur.join('\n')); cur = []; continue; }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/** Coupe une ligne trop longue (aux espaces si possible). */
function splitLine(line: string, max: number): string[] {
  const out: string[] = []; let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Bloc plus long que `max` : découpé par lignes ; un bloc de code est refermé puis rouvert à chaque morceau. */
function hardSplit(block: string, max: number): string[] {
  const lines = block.split('\n');
  const isCode = FENCE.test(lines[0]) && lines.length > 1 && FENCE.test(lines[lines.length - 1]);
  const head = isCode ? lines[0].trim() : '';
  const body = isCode ? lines.slice(1, -1) : lines;
  const budget = isCode ? max - head.length - 5 : max; // « head\n…\n``` »
  const out: string[] = []; let cur: string[] = []; let len = 0;
  const flush = () => { if (cur.length) out.push(isCode ? `${head}\n${cur.join('\n')}\n\`\`\`` : cur.join('\n')); cur = []; len = 0; };
  for (const l of body) {
    for (const piece of l.length > budget ? splitLine(l, budget) : [l]) {
      if (len + piece.length + (cur.length ? 1 : 0) > budget) flush();
      cur.push(piece); len += piece.length + (cur.length > 1 ? 1 : 0);
    }
  }
  flush();
  return out;
}

/** Découpe un texte Markdown en messages de `max` caractères maximum, aux frontières de paragraphes. */
export function splitMessage(text: string, max: number = LIMITS.content): string[] {
  const out: string[] = []; let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const b of splitBlocks(text)) {
    if (b.length > max) { push(); out.push(...hardSplit(b, max).filter(s => s.trim())); continue; }
    if (cur && cur.length + 2 + b.length > max) push();
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  push();
  return out;
}

export const embedSize = (e: DiscordEmbed) =>
  (e.title?.trim().length ?? 0) + (e.description?.trim().length ?? 0) + (e.footer?.text.trim().length ?? 0) + (e.author?.name.trim().length ?? 0)
  + (e.fields ?? []).reduce((s, f) => s + f.name.trim().length + f.value.trim().length, 0);

/** Regroupe des embeds en messages (≤ 10 embeds et ≤ 6000 caractères chacun). */
export function packEmbeds(embeds: DiscordEmbed[]): DiscordPayload[] {
  const out: DiscordPayload[] = []; let cur: DiscordEmbed[] = []; let size = 0;
  for (const e of embeds) {
    const s = embedSize(e);
    if (cur.length && (cur.length >= LIMITS.embeds || size + s > LIMITS.total)) { out.push({ embeds: cur }); cur = []; size = 0; }
    cur.push(e); size += s;
  }
  if (cur.length) out.push({ embeds: cur });
  return out;
}

export interface PageLike { title?: string; icon?: string; content: unknown }
export interface ConvertOptions { mode: 'message' | 'embed'; color?: number; url?: string; footer?: string; timestamp?: string }

/** Convertit une page en une suite de messages Discord prêts à envoyer (dans l'ordre). */
export function pageToDiscord(page: PageLike, opts: ConvertOptions): DiscordPayload[] {
  const title = `${page.icon ? page.icon + ' ' : ''}${page.title?.trim() || 'Sans titre'}`;
  if (opts.mode === 'message') {
    const body = docToMarkdown(page.content, { flavor: 'discord', headings: 'markdown' });
    const full = `# ${title}${body ? `\n\n${body}` : ''}${opts.footer ? `\n\n-# ${opts.footer}` : ''}`;
    return splitMessage(full, LIMITS.content).map(content => ({ content }));
  }
  const body = docToMarkdown(page.content, { flavor: 'discord', headings: 'bold' });
  // 4000 (< 4096) : marge pour les blocs de code refermés.
  const chunks = body ? splitMessage(body, 4000) : [''];
  const color = opts.color ?? 0x0a84ff;
  const embeds: DiscordEmbed[] = chunks.map((d, i) => ({
    ...(i === 0 ? { title: truncate(title, LIMITS.title), ...(opts.url ? { url: opts.url } : {}) } : {}),
    ...(d ? { description: d } : {}),
    color,
  }));
  const img = firstImageUrl(page.content);
  if (img) embeds[0].image = { url: img };
  const last = embeds[embeds.length - 1];
  if (opts.footer) last.footer = { text: truncate(opts.footer, LIMITS.footer) };
  if (opts.timestamp) last.timestamp = opts.timestamp;
  return packEmbeds(embeds);
}

/** Texte brut → messages (outil Claude discord_send, annonces). */
export function textToDiscord(content: string, title?: string, color?: number): DiscordPayload[] {
  if (!title) return splitMessage(content, LIMITS.content).map(c => ({ content: c }));
  const chunks = splitMessage(content, 4000);
  return packEmbeds(chunks.map((d, i) => ({ ...(i === 0 ? { title: truncate(title, LIMITS.title) } : {}), description: d, color: color ?? 0x0a84ff })));
}
