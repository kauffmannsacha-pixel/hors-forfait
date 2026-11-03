// Client REST de l'API Gmail v1 (jeton OAuth fourni par le connecteur Google).
// https://developers.google.com/gmail/api/reference/rest
import { google } from '../connectors/api';
import { httpFetch } from '../db/http';
import type { MailAccount } from './types';
import { ALL_MAIL, type GmailLabel, type GmailMessage, type GmailThread } from './gmailParse';
import { base64UrlToBase64, sleep } from './util';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'];
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const META_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'];

/** L'historyId fourni est trop ancien : il faut une resynchronisation complète. */
export class HistoryExpiredError extends Error { constructor() { super("Historique Gmail expiré — resynchronisation complète."); this.name = 'HistoryExpiredError'; } }

type Query = Record<string, string | number | boolean | string[] | undefined>;

function gmailError(status: number, body: string): Error {
  let detail = '';
  try { detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? ''; } catch { detail = body.slice(0, 200); }
  const map: Record<number, string> = {
    400: 'requête refusée', 401: 'autorisation expirée — reconnecte le compte Google dans Réglages → Mail',
    403: 'accès refusé (autorisation Gmail manquante ou quota dépassé)', 404: 'message introuvable (supprimé ?)',
    429: 'trop de requêtes, réessaie dans un instant', 500: 'erreur interne de Gmail', 503: 'Gmail est momentanément indisponible',
  };
  return new Error(`Gmail : ${map[status] ?? 'erreur ' + status}${detail ? ' — ' + detail : ''}`);
}

async function call<T>(acc: MailAccount, path: string, o: { method?: string; query?: Query; body?: unknown } = {}): Promise<T> {
  if (!acc.googleAccountId) throw new Error('Ce compte Gmail n’est relié à aucun compte Google — reconnecte-le dans Réglages → Mail.');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x)); else qs.append(k, String(v));
  }
  const q = qs.toString();
  const url = `${BASE}${path}${q ? '?' + q : ''}`;
  for (let attempt = 0; ; attempt++) {
    const token = await google.token(acc.googleAccountId, GMAIL_SCOPES);
    const r = await httpFetch(url, {
      method: o.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (r.ok) {
      if (r.status === 204) return undefined as T;
      const txt = await r.text();
      return (txt ? JSON.parse(txt) : undefined) as T;
    }
    const body = await r.text().catch(() => '');
    const rate = r.status === 429 || (r.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(body));
    if ((rate || r.status >= 500 || (r.status === 401 && attempt === 0)) && attempt < 3) { await sleep(700 * 2 ** attempt + Math.random() * 300); continue; }
    if (r.status === 404 && path.startsWith('/history')) throw new HistoryExpiredError();
    throw gmailError(r.status, body);
  }
}

const enc = encodeURIComponent;

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailMessage }[];
  messagesDeleted?: { message: GmailMessage }[];
  labelsAdded?: { message: GmailMessage; labelIds: string[] }[];
  labelsRemoved?: { message: GmailMessage; labelIds: string[] }[];
}

export const gmail = {
  profile: (acc: MailAccount) => call<{ emailAddress: string; historyId: string; messagesTotal?: number; threadsTotal?: number }>(acc, '/profile'),
  labels: async (acc: MailAccount) => (await call<{ labels?: GmailLabel[] }>(acc, '/labels')).labels ?? [],
  label: (acc: MailAccount, id: string) => call<GmailLabel>(acc, `/labels/${enc(id)}`),
  listThreads: (acc: MailAccount, o: { labelId?: string; q?: string; pageToken?: string; max?: number }) =>
    call<{ threads?: { id: string; snippet?: string; historyId?: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(acc, '/threads', {
      query: {
        labelIds: o.labelId && o.labelId !== ALL_MAIL ? o.labelId : undefined,
        q: o.q, pageToken: o.pageToken, maxResults: o.max ?? 30,
        includeSpamTrash: o.labelId === 'SPAM' || o.labelId === 'TRASH' ? true : undefined,
      },
    }),
  getThread: (acc: MailAccount, id: string, format: 'metadata' | 'full' = 'metadata') =>
    call<GmailThread>(acc, `/threads/${enc(id)}`, { query: { format, metadataHeaders: format === 'metadata' ? META_HEADERS : undefined } }),
  getMessage: (acc: MailAccount, id: string, format: 'full' | 'raw' | 'metadata' = 'full') =>
    call<GmailMessage>(acc, `/messages/${enc(id)}`, { query: { format, metadataHeaders: format === 'metadata' ? META_HEADERS : undefined } }),
  listMessages: (acc: MailAccount, o: { labelId?: string; q?: string; max?: number }) =>
    call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(acc, '/messages', { query: { labelIds: o.labelId, q: o.q, maxResults: o.max ?? 20 } }),
  modifyThread: (acc: MailAccount, id: string, add: string[], remove: string[]) =>
    call<GmailThread>(acc, `/threads/${enc(id)}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } }),
  batchModify: (acc: MailAccount, ids: string[], add: string[], remove: string[]) =>
    call<void>(acc, '/messages/batchModify', { method: 'POST', body: { ids, addLabelIds: add, removeLabelIds: remove } }),
  trashThread: (acc: MailAccount, id: string) => call<GmailThread>(acc, `/threads/${enc(id)}/trash`, { method: 'POST' }),
  untrashThread: (acc: MailAccount, id: string) => call<GmailThread>(acc, `/threads/${enc(id)}/untrash`, { method: 'POST' }),
  /** Contenu d'une pièce jointe, en base64 standard. */
  attachment: async (acc: MailAccount, messageId: string, attachmentId: string) =>
    base64UrlToBase64((await call<{ data: string; size: number }>(acc, `/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`)).data ?? ''),
  createDraft: (acc: MailAccount, raw: string, threadId?: string) =>
    call<{ id: string; message: { id: string; threadId: string } }>(acc, '/drafts', { method: 'POST', body: { message: { raw, ...(threadId ? { threadId } : {}) } } }),
  updateDraft: (acc: MailAccount, draftId: string, raw: string, threadId?: string) =>
    call<{ id: string; message: { id: string; threadId: string } }>(acc, `/drafts/${enc(draftId)}`, { method: 'PUT', body: { id: draftId, message: { raw, ...(threadId ? { threadId } : {}) } } }),
  deleteDraft: (acc: MailAccount, draftId: string) => call<void>(acc, `/drafts/${enc(draftId)}`, { method: 'DELETE' }),
  /** Envoi — appelé uniquement après clic « Envoyer » + confirmation. */
  send: (acc: MailAccount, raw: string, threadId?: string) =>
    call<GmailMessage>(acc, '/messages/send', { method: 'POST', body: { raw, ...(threadId ? { threadId } : {}) } }),
  history: (acc: MailAccount, startHistoryId: string, pageToken?: string) =>
    call<{ history?: GmailHistoryRecord[]; historyId: string; nextPageToken?: string }>(acc, '/history', {
      query: { startHistoryId, pageToken, maxResults: 500, historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'] },
    }),
};

/** Lien web Gmail vers un fil (compte choisi par adresse). */
export const gmailWebLink = (email: string, threadId: string) => `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#all/${threadId}`;
