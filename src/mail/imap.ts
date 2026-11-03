// Pont vers les commandes Rust IMAP/SMTP (src-tauri/src/mail.rs). Les mots de passe sont lus
// dans le coffre au moment de l'appel et ne sont jamais stockés ailleurs.
import { isTauri } from '../db/store';
import type { MailAccount, MailAddress } from './types';
import { getPassword } from './accounts';
import { errorText } from './util';

export interface RsAddr { name?: string | null; email: string }
export interface RsFolder { path: string; name: string; fullName: string; delimiter?: string | null; role?: string | null; selectable: boolean; depth: number; total?: number | null; unread?: number | null }
export interface RsHeader {
  uid: number; messageId?: string | null; inReplyTo?: string | null; references: string[]; subject: string;
  from?: RsAddr | null; to: RsAddr[]; cc: RsAddr[]; replyTo: RsAddr[]; date: number; flags: string[];
  seen: boolean; flagged: boolean; answered: boolean; draft: boolean; size: number; snippet: string; hasAttachments: boolean;
}
export interface RsFetch { folder: string; uidValidity?: number | null; uidNext?: number | null; exists: number; messages: RsHeader[] }
export interface RsAttachment { index: number; name: string; mime: string; size: number; contentId?: string | null; inline: boolean; data?: string | null }
export interface RsMessage { header: RsHeader; bcc: RsAddr[]; html?: string | null; text: string; attachments: RsAttachment[]; listUnsubscribe?: string | null; raw?: string | null }
export interface RsFlags { uid: number; flags: string[]; seen: boolean; flagged: boolean; answered: boolean }
export interface RsTest { ok: boolean; folders: number; capabilities: string[]; message: string }
export interface OutgoingMessage {
  from: MailAddress; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; replyTo?: MailAddress;
  subject: string; text: string; html?: string; inReplyTo?: string; references: string[];
  attachments: { name: string; mime: string; data: string; contentId?: string; inline?: boolean }[];
}

interface Creds {
  id: string; email: string; name: string; acceptInvalidCerts: boolean;
  imap?: { host: string; port: number; security: string; username: string; password: string };
  smtp?: { host: string; port: number; security: string; username: string; password: string };
}

async function invokeRs<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('Les comptes IMAP/SMTP fonctionnent uniquement dans l’application de bureau Prisme.');
  const { invoke } = await import('@tauri-apps/api/core');
  try { return await invoke<T>(cmd, args); }
  catch (e) { throw new Error(errorText(e)); }
}

/**
 * Identifiants pour Rust. `lane` donne une connexion séparée (ex. « sync » pour la synchro
 * d'arrière-plan, afin de ne pas bloquer les actions de l'utilisateur).
 * `override` permet de tester un compte avant de l'enregistrer.
 */
export async function credsOf(acc: MailAccount, lane?: string, override?: { password?: string; smtpPassword?: string }): Promise<Creds> {
  const pwd = override?.password ?? await getPassword(acc.id);
  const smtpPwd = acc.smtpOwnPassword ? (override?.smtpPassword ?? await getPassword(acc.id, true)) : pwd;
  if (!pwd && acc.imap) throw new Error(`Mot de passe manquant pour ${acc.email} — Réglages → Mail → Comptes.`);
  return {
    id: lane ? `${acc.id}#${lane}` : acc.id,
    email: acc.email,
    name: acc.name,
    acceptInvalidCerts: !!acc.acceptInvalidCerts,
    imap: acc.imap ? { ...acc.imap, password: pwd } : undefined,
    smtp: acc.smtp ? { ...acc.smtp, password: smtpPwd } : undefined,
  };
}

type Lane = { lane?: string };
export const imap = {
  test: async (acc: MailAccount, override?: { password?: string; smtpPassword?: string }) =>
    invokeRs<RsTest>('mail_imap_test', { account: await credsOf(acc, 'test', override) }),
  smtpTest: async (acc: MailAccount, override?: { password?: string; smtpPassword?: string }) =>
    invokeRs<string>('mail_smtp_test', { account: await credsOf(acc, 'test', override) }),
  folders: async (acc: MailAccount, o: Lane & { withCounts?: boolean } = {}) =>
    invokeRs<RsFolder[]>('mail_imap_folders', { account: await credsOf(acc, o.lane), withCounts: o.withCounts ?? true }),
  fetch: async (acc: MailAccount, folder: string, o: Lane & { sinceUid?: number; beforeUid?: number; limit?: number } = {}) =>
    invokeRs<RsFetch>('mail_imap_fetch', { account: await credsOf(acc, o.lane), folder, sinceUid: o.sinceUid ?? null, limit: o.limit ?? 50, beforeUid: o.beforeUid ?? null }),
  fetchMessage: async (acc: MailAccount, folder: string, uid: number, o: Lane & { attachmentData?: 'none' | 'inline' | 'all'; includeRaw?: boolean } = {}) =>
    invokeRs<RsMessage>('mail_imap_fetch_message', { account: await credsOf(acc, o.lane), folder, uid, attachmentData: o.attachmentData ?? 'inline', includeRaw: o.includeRaw ?? false }),
  fetchAttachment: async (acc: MailAccount, folder: string, uid: number, index: number) =>
    invokeRs<RsAttachment>('mail_imap_fetch_attachment', { account: await credsOf(acc), folder, uid, index }),
  flags: async (acc: MailAccount, folder: string, uids: number[], o: Lane = {}) =>
    invokeRs<RsFlags[]>('mail_imap_flags', { account: await credsOf(acc, o.lane), folder, uids }),
  setFlags: async (acc: MailAccount, folder: string, uids: number[], add: string[], remove: string[]) =>
    invokeRs<void>('mail_imap_set_flags', { account: await credsOf(acc), folder, uids, add, remove }),
  move: async (acc: MailAccount, folder: string, uids: number[], target: string) =>
    invokeRs<void>('mail_imap_move', { account: await credsOf(acc), folder, uids, target }),
  deleteForever: async (acc: MailAccount, folder: string, uids: number[]) =>
    invokeRs<void>('mail_imap_delete', { account: await credsOf(acc), folder, uids }),
  search: async (acc: MailAccount, folder: string, query: string, limit = 50) =>
    invokeRs<RsFetch>('mail_imap_search', { account: await credsOf(acc), folder, query, limit }),
  append: async (acc: MailAccount, folder: string, raw: string, flags: string[] = []) =>
    invokeRs<void>('mail_imap_append', { account: await credsOf(acc), folder, raw, flags }),
  createFolder: async (acc: MailAccount, name: string) =>
    invokeRs<string>('mail_imap_create_folder', { account: await credsOf(acc), name }),
  disconnect: (accountId: string) => (isTauri ? invokeRs<void>('mail_imap_disconnect', { accountId }) : Promise.resolve()),
  /** Envoi SMTP — appelé uniquement après clic « Envoyer » + confirmation. */
  send: async (acc: MailAccount, message: OutgoingMessage) =>
    invokeRs<{ messageId: string; raw: string }>('mail_smtp_send', { account: await credsOf(acc), message }),
};

export const toAddr = (a?: RsAddr | null): MailAddress => (a ? (a.name ? { name: a.name, email: a.email } : { email: a.email }) : { email: '' });
