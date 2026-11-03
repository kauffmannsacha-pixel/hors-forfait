// Conversion des réponses de l'API Gmail vers les types du module (pur, testé).
import type { MailAttachment, MailFolder, MailHeader } from './types';
import { base64ToBytes, base64UrlToBase64, decodeBytes, parseAddressList } from './util';

export interface GmailHeaderKV { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailHeaderKV[];
  body?: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
  raw?: string;
}
export interface GmailThread { id: string; historyId?: string; snippet?: string; messages?: GmailMessage[] }
export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  labelListVisibility?: string;
  color?: { backgroundColor?: string; textColor?: string };
}

export const ALL_MAIL = '__ALL__';
/** Libellés système affichés, dans l'ordre d'Apple Mail. */
export const GMAIL_SYSTEM: { id: string; name: string; role: MailFolder['role'] }[] = [
  { id: 'INBOX', name: 'Réception', role: 'inbox' },
  { id: 'STARRED', name: 'Suivis', role: 'flagged' },
  { id: 'IMPORTANT', name: 'Importants', role: 'important' },
  { id: 'SENT', name: 'Envoyés', role: 'sent' },
  { id: 'DRAFT', name: 'Brouillons', role: 'drafts' },
  { id: ALL_MAIL, name: 'Tous les messages', role: 'all' },
  { id: 'SPAM', name: 'Spam', role: 'junk' },
  { id: 'TRASH', name: 'Corbeille', role: 'trash' },
];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Décode les entités HTML des extraits Gmail (« L&#39;été » → « L'été »). */
export function decodeEntities(s: string): string {
  return (s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function headerMap(headers?: GmailHeaderKV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) { const k = h.name.toLowerCase(); if (!(k in out)) out[k] = h.value; }
  return out;
}

const ids = (v?: string) => (v ?? '').split(/[\s,]+/).map(x => x.trim().replace(/^<|>$/g, '')).filter(x => x.includes('@') || x.length > 6);

/** Décodage robuste : UTF-8 strict d'abord (Gmail transcode parfois), sinon le charset déclaré. */
export function decodePartData(data: string, charset?: string): string {
  const bytes = base64ToBytes(data);
  const cs = (charset ?? '').toLowerCase().replace(/"/g, '').trim();
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return decodeBytes(bytes, 'utf-8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return decodeBytes(bytes, cs); }
}

export function gmailToHeader(accountId: string, m: GmailMessage, folder: string): MailHeader {
  const h = headerMap(m.payload?.headers);
  const labels = m.labelIds ?? [];
  const from = parseAddressList(h['from'] ?? '')[0] ?? { email: '' };
  const internal = Number(m.internalDate ?? 0);
  const mime = (m.payload?.mimeType ?? '').toLowerCase();
  return {
    key: `${accountId}|${m.id}`,
    accountId,
    providerId: m.id,
    folder,
    threadId: m.threadId,
    messageId: ids(h['message-id'])[0],
    inReplyTo: ids(h['in-reply-to'])[0],
    references: ids(h['references']),
    subject: (h['subject'] ?? '').trim(),
    from,
    to: parseAddressList(h['to'] ?? ''),
    cc: parseAddressList(h['cc'] ?? ''),
    replyTo: h['reply-to'] ? parseAddressList(h['reply-to']) : undefined,
    date: internal || Date.parse(h['date'] ?? '') || 0,
    snippet: decodeEntities(m.snippet ?? '').replace(/\s+/g, ' ').trim(),
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    draft: labels.includes('DRAFT'),
    labels,
    hasAttachments: hasAttachmentParts(m.payload) || mime === 'multipart/mixed',
    size: m.sizeEstimate,
  };
}

function hasAttachmentParts(p?: GmailPart): boolean {
  if (!p) return false;
  if (p.filename && (p.body?.attachmentId || p.body?.data)) {
    const disp = headerMap(p.headers)['content-disposition'] ?? '';
    const cid = headerMap(p.headers)['content-id'];
    if (!cid || /attachment/i.test(disp)) return true;
  }
  return (p.parts ?? []).some(hasAttachmentParts);
}

export interface GmailBody { html?: string; text: string; attachments: MailAttachment[] }

export function gmailBody(m: GmailMessage): GmailBody {
  const html: string[] = []; const text: string[] = []; const attachments: MailAttachment[] = [];
  const walk = (p: GmailPart, inAlternative: boolean) => {
    const mime = (p.mimeType ?? '').toLowerCase();
    const hm = headerMap(p.headers);
    const disp = hm['content-disposition'] ?? '';
    const isAttach = !!p.filename || /^\s*attachment/i.test(disp);
    if (mime.startsWith('multipart/')) { (p.parts ?? []).forEach(c => walk(c, mime === 'multipart/alternative')); return; }
    if (!isAttach && (mime === 'text/html' || mime === 'text/plain') && p.body?.data) {
      const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(hm['content-type'] ?? '')?.[1];
      const t = decodePartData(p.body.data, charset);
      (mime === 'text/html' ? html : text).push(t);
      return;
    }
    if (!isAttach && (mime === 'text/html' || mime === 'text/plain') && !p.body?.attachmentId) return;
    if (p.body?.attachmentId || p.body?.data) {
      const cid = (hm['content-id'] ?? hm['x-attachment-id'] ?? '').replace(/^<|>$/g, '').trim() || undefined;
      const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
      attachments.push({
        id: p.body.attachmentId ?? `part-${p.partId ?? attachments.length}`,
        name: p.filename || (mime === 'message/rfc822' ? 'message.eml' : `piece-jointe-${attachments.length + 1}.${ext}`),
        mime: mime || 'application/octet-stream',
        size: p.body.size ?? 0,
        contentId: cid,
        inline: !!cid && !/^\s*attachment/i.test(disp),
        data: p.body.data ? base64UrlToBase64(p.body.data) : undefined,
      });
    }
    void inAlternative;
  };
  if (m.payload) walk(m.payload, false);
  return { html: html.length ? html.join('\n') : undefined, text: text.join('\n\n'), attachments };
}

export function gmailLabelsToFolders(accountId: string, labels: GmailLabel[]): MailFolder[] {
  const byId = new Map(labels.map(l => [l.id, l]));
  const sys: MailFolder[] = GMAIL_SYSTEM.filter(s => s.id === ALL_MAIL || byId.has(s.id)).map(s => {
    const l = byId.get(s.id);
    return { accountId, id: s.id, name: s.name, role: s.role, selectable: true, depth: 0, system: true, unread: s.id === 'INBOX' ? l?.threadsUnread : undefined, total: l?.threadsTotal };
  });
  const user = labels
    .filter(l => l.type === 'user' && l.labelListVisibility !== 'labelHide')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .map<MailFolder>(l => {
      const segs = l.name.split('/');
      return { accountId, id: l.id, name: segs[segs.length - 1], selectable: true, depth: segs.length - 1, color: l.color?.backgroundColor, unread: l.threadsUnread, total: l.threadsTotal };
    });
  return [...sys, ...user];
}
