// Construction d'un message MIME (RFC 5322 / 2045-2047 / 2231) — utilisé pour l'API Gmail
// (messages.send / drafts.create attendent le message brut en base64url). Pur et testé.
import type { MailAddress } from './types';
import { bytesToBase64, toBase64Url, utf8ToBase64 } from './util';

export interface MimeAttachment { name: string; mime: string; data: string /* base64 */; contentId?: string; inline?: boolean }
export interface MimeInput {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  date?: Date;
  attachments?: MimeAttachment[];
  /** Graine des séparateurs MIME (tests déterministes). */
  boundarySeed?: string;
  extraHeaders?: Record<string, string>;
}

const CRLF = '\r\n';
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Encode un texte en mots encodés RFC 2047 (UTF-8, base64), sans couper un caractère. */
export function encodeWord(s: string): string {
  if (isAscii(s)) return s;
  const enc = new TextEncoder(); const words: string[] = [];
  let chunk = ''; let bytes = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (bytes + n > 45 && chunk) { words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`); chunk = ''; bytes = 0; }
    chunk += ch; bytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
  return words.join(CRLF + ' ');
}

/** Une adresse pour un en-tête : `Nom <a@b>` (nom encodé ou entre guillemets si besoin). */
export function encodeAddress(a: MailAddress): string {
  const email = a.email.trim();
  const name = (a.name ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  if (!isAscii(name)) return `${encodeWord(name)} <${email}>`;
  if (/[()<>[\]:;@\\,."]/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>`;
  return `${name} <${email}>`;
}

export function encodeAddressList(list: MailAddress[]): string {
  const parts = list.filter(a => a.email.trim()).map(encodeAddress);
  const one = parts.join(', ');
  return one.length > 70 ? parts.join(',' + CRLF + ' ') : one;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
/** Date au format RFC 5322 (« Tue, 03 Nov 2026 14:05:00 +0100 »), fuseau local. */
export function rfc2822Date(d: Date): string {
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? '+' : '-'; const a = Math.abs(off);
  return `${DAYS[d.getDay()]}, ${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${sign}${p2(Math.floor(a / 60))}${p2(a % 60)}`;
}

/** Base64 coupé en lignes de 76 caractères. */
export const wrapBase64 = (b64: string, width = 76) => (b64.match(new RegExp(`.{1,${width}}`, 'g')) ?? ['']).join(CRLF);

const angle = (id: string) => `<${id.trim().replace(/^<|>$/g, '')}>`;

/** Paramètre de nom de fichier : `filename="ascii"; filename*=UTF-8''pourcent-encodé` (RFC 2231). */
export function fileNameParams(name: string, param: 'filename' | 'name'): string {
  const safe = name.replace(/[\r\n"\\]/g, '_');
  if (isAscii(safe)) return `${param}="${safe}"`;
  const fallback = safe.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_');
  const enc = encodeURIComponent(safe).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return param === 'filename' ? `filename="${fallback}"; filename*=UTF-8''${enc}` : `name="=?UTF-8?B?${utf8ToBase64(safe)}?="`;
}

interface Part { headers: string[]; body: string }
const textPart = (content: string, subtype: 'plain' | 'html'): Part => ({
  headers: [`Content-Type: text/${subtype}; charset="UTF-8"`, 'Content-Transfer-Encoding: base64'],
  body: wrapBase64(utf8ToBase64(content)),
});

function render(p: Part): string { return p.headers.join(CRLF) + CRLF + CRLF + p.body; }

export function buildMime(input: MimeInput): string {
  let seq = 0;
  const seed = input.boundarySeed ?? Math.random().toString(36).slice(2, 12);
  const boundary = () => `=_Prisme_${seed}_${++seq}`;
  const multipart = (kind: 'mixed' | 'alternative' | 'related', parts: Part[]): Part => {
    const b = boundary();
    return {
      headers: [`Content-Type: multipart/${kind}; boundary="${b}"`],
      body: parts.map(p => `--${b}${CRLF}${render(p)}`).join(CRLF) + `${CRLF}--${b}--`,
    };
  };
  const attachmentPart = (a: MimeAttachment, inline: boolean): Part => ({
    headers: [
      `Content-Type: ${a.mime || 'application/octet-stream'}; ${fileNameParams(a.name, 'name')}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${inline ? 'inline' : 'attachment'}; ${fileNameParams(a.name, 'filename')}`,
      ...(inline && a.contentId ? [`Content-ID: ${angle(a.contentId)}`] : []),
    ],
    body: wrapBase64(a.data.replace(/\s+/g, '')),
  });

  const atts = input.attachments ?? [];
  const isInline = (a: MimeAttachment) => !!(a.inline && a.contentId);
  const inline = input.html ? atts.filter(isInline) : [];
  const regular = atts.filter(a => !inline.includes(a));

  let core: Part;
  if (input.html && input.html.trim()) {
    const htmlPart = textPart(input.html, 'html');
    const htmlBlock = inline.length ? multipart('related', [htmlPart, ...inline.map(a => attachmentPart(a, true))]) : htmlPart;
    core = multipart('alternative', [textPart(input.text, 'plain'), htmlBlock]);
  } else {
    core = textPart(input.text, 'plain');
  }
  const root = regular.length ? multipart('mixed', [core, ...regular.map(a => attachmentPart(a, false))]) : core;

  const h: string[] = [];
  h.push(`Date: ${rfc2822Date(input.date ?? new Date())}`);
  h.push(`From: ${encodeAddress(input.from)}`);
  if (input.to.length) h.push(`To: ${encodeAddressList(input.to)}`);
  if (input.cc?.length) h.push(`Cc: ${encodeAddressList(input.cc)}`);
  if (input.bcc?.length) h.push(`Bcc: ${encodeAddressList(input.bcc)}`);
  if (input.replyTo) h.push(`Reply-To: ${encodeAddress(input.replyTo)}`);
  h.push(`Subject: ${encodeWord(input.subject.replace(/[\r\n]+/g, ' '))}`);
  if (input.messageId) h.push(`Message-ID: ${angle(input.messageId)}`);
  if (input.inReplyTo) h.push(`In-Reply-To: ${angle(input.inReplyTo)}`);
  const refs = (input.references ?? []).map(r => r.trim()).filter(Boolean);
  if (refs.length) h.push(`References: ${refs.map(angle).join(CRLF + ' ')}`);
  for (const [k, v] of Object.entries(input.extraHeaders ?? {})) h.push(`${k}: ${encodeWord(v.replace(/[\r\n]+/g, ' '))}`);
  h.push('MIME-Version: 1.0');
  return h.join(CRLF) + CRLF + root.headers.join(CRLF) + CRLF + CRLF + root.body + CRLF;
}

/** Message brut encodé pour l'API Gmail (`raw`, base64url sans remplissage). */
export const toGmailRaw = (mime: string) => toBase64Url(utf8ToBase64(mime));
/** Message brut en base64 standard (copie IMAP, .eml). */
export const mimeToBase64 = (mime: string) => bytesToBase64(new TextEncoder().encode(mime));
