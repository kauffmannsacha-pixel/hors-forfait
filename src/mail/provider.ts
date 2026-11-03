// Opérations unifiées Gmail (API REST) / IMAP-SMTP (Rust). Le store s'appuie uniquement sur ce module.
import type { FolderCache, FolderRole, FolderSyncState, LocalDraft, MailAccount, MailAttachment, MailBody, MailFolder, MailHeader } from './types';
import { gmail, HistoryExpiredError } from './gmail';
import { ALL_MAIL, gmailBody, gmailLabelsToFolders, gmailToHeader, type GmailThread } from './gmailParse';
import { imap, toAddr, type RsFolder, type RsHeader } from './imap';
import { folderByRole, guessRole, sortFolders } from './folders';
import { buildMime, toGmailRaw } from './mime';
import { htmlToText } from './compose';
import { base64UrlToBase64, mapLimit } from './util';

const PAGE = 30;

// ── Conversions IMAP ──
function imapFolder(accountId: string, f: RsFolder): MailFolder {
  const role = (f.role as FolderRole | null | undefined) ?? guessRole(f.path, f.name);
  return { accountId, id: f.path, name: f.name, role: role ?? undefined, unread: f.unread ?? undefined, total: f.total ?? undefined, selectable: f.selectable, depth: f.depth, system: !!role };
}
export function imapHeader(accountId: string, folder: string, h: RsHeader): MailHeader {
  return {
    key: `${accountId}|${folder}|${h.uid}`, accountId, providerId: String(h.uid), folder, uid: h.uid,
    messageId: h.messageId ?? undefined, inReplyTo: h.inReplyTo ?? undefined, references: h.references ?? [],
    subject: h.subject ?? '', from: toAddr(h.from), to: (h.to ?? []).map(toAddr), cc: (h.cc ?? []).map(toAddr),
    replyTo: h.replyTo?.length ? h.replyTo.map(toAddr) : undefined,
    date: h.date, snippet: h.snippet ?? '', unread: !h.seen, starred: h.flagged, answered: h.answered, draft: h.draft,
    hasAttachments: h.hasAttachments, size: h.size,
  };
}
const byFolder = (hs: MailHeader[]) => {
  const m = new Map<string, MailHeader[]>();
  for (const h of hs) { const a = m.get(h.folder); if (a) a.push(h); else m.set(h.folder, [h]); }
  return m;
};
const uids = (hs: MailHeader[]) => hs.map(h => h.uid).filter((u): u is number => typeof u === 'number');
const threadIds = (hs: MailHeader[]) => [...new Set(hs.map(h => h.threadId).filter((t): t is string => !!t))];

// ── Dossiers ──
export async function listFolders(acc: MailAccount, lane?: string): Promise<MailFolder[]> {
  if (acc.kind === 'gmail') {
    const labels = await gmail.labels(acc);
    const inbox = await gmail.label(acc, 'INBOX').catch(() => undefined);
    return gmailLabelsToFolders(acc.id, labels.map(l => (l.id === 'INBOX' && inbox ? { ...l, ...inbox } : l)));
  }
  const rs = await imap.folders(acc, { lane, withCounts: true });
  return sortFolders(rs.map(f => imapFolder(acc.id, f)));
}

// ── Liste des messages ──
export interface RefreshResult { cache: FolderCache; /** Arrivés depuis la dernière synchro. */ newKeys: string[] }

function gmailThreadHeaders(acc: MailAccount, t: GmailThread | null, folder: string): MailHeader[] {
  return (t?.messages ?? []).map(m => gmailToHeader(acc.id, m, folder));
}
const inFolder = (hs: MailHeader[], folder: string) =>
  folder === ALL_MAIL ? hs.some(h => !h.labels?.includes('SPAM') && !h.labels?.includes('TRASH')) : hs.some(h => h.labels?.includes(folder));

async function gmailFull(acc: MailAccount, folder: string, prev?: FolderCache): Promise<RefreshResult> {
  const profile = await gmail.profile(acc);
  const list = await gmail.listThreads(acc, { labelId: folder, max: PAGE });
  const threads = await mapLimit(list.threads ?? [], 6, t => gmail.getThread(acc, t.id).catch(() => null));
  const headers = threads.flatMap(t => gmailThreadHeaders(acc, t, folder));
  const known = new Set(prev?.headers.map(h => h.key) ?? []);
  return {
    cache: { headers, sync: { historyId: profile.historyId, nextPageToken: list.nextPageToken, exhausted: !list.nextPageToken, lastSync: Date.now() } },
    newKeys: prev ? headers.filter(h => !known.has(h.key) && h.unread).map(h => h.key) : [],
  };
}

async function gmailIncremental(acc: MailAccount, folder: string, prev: FolderCache): Promise<RefreshResult> {
  let token: string | undefined; let historyId = prev.sync.historyId!; const changed = new Set<string>();
  for (let page = 0; page < 6; page++) {
    const r = await gmail.history(acc, prev.sync.historyId!, token);
    for (const rec of r.history ?? []) {
      for (const x of [...(rec.messagesAdded ?? []), ...(rec.messagesDeleted ?? []), ...(rec.labelsAdded ?? []), ...(rec.labelsRemoved ?? [])]) changed.add(x.message.threadId);
    }
    historyId = r.historyId ?? historyId; token = r.nextPageToken;
    if (!token) break;
  }
  if (!changed.size) return { cache: { headers: prev.headers, sync: { ...prev.sync, historyId, lastSync: Date.now() } }, newKeys: [] };
  if (changed.size > 80) return gmailFull(acc, folder, prev);
  const ids = [...changed];
  const fetched = await mapLimit(ids, 6, async id => ({ id, t: await gmail.getThread(acc, id).catch(() => null) }));
  const known = new Set(prev.headers.map(h => h.key));
  let headers = prev.headers.filter(h => !changed.has(h.threadId ?? ''));
  const added: MailHeader[] = [];
  for (const { t } of fetched) {
    const hs = gmailThreadHeaders(acc, t, folder);
    if (hs.length && inFolder(hs, folder)) added.push(...hs);
  }
  headers = [...added, ...headers];
  return {
    cache: { headers, sync: { ...prev.sync, historyId, lastSync: Date.now() } },
    newKeys: added.filter(h => !known.has(h.key) && h.unread && (folder !== 'INBOX' || h.labels?.includes('INBOX'))).map(h => h.key),
  };
}

async function imapRefresh(acc: MailAccount, folder: string, prev: FolderCache | undefined, lane?: string): Promise<RefreshResult> {
  const cached = prev?.headers.filter(h => h.folder === folder && typeof h.uid === 'number') ?? [];
  const maxUid = cached.reduce((m, h) => Math.max(m, h.uid ?? 0), 0);
  let res = await imap.fetch(acc, folder, { lane, sinceUid: maxUid || undefined, limit: maxUid ? 200 : 50 });
  const validityChanged = !!(prev?.sync.uidValidity && res.uidValidity && prev.sync.uidValidity !== res.uidValidity);
  if (validityChanged) res = await imap.fetch(acc, folder, { lane, limit: 50 });
  const fresh = res.messages.map(m => imapHeader(acc.id, folder, m));
  let headers: MailHeader[];
  if (maxUid && !validityChanged) {
    const recent = [...cached].sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0)).slice(0, 400);
    const flags = recent.length ? await imap.flags(acc, folder, uids(recent), { lane }) : [];
    const fm = new Map(flags.map(f => [f.uid, f]));
    const checked = new Set(uids(recent));
    const kept = cached
      .filter(h => !checked.has(h.uid!) || fm.has(h.uid!))
      .map(h => { const f = fm.get(h.uid!); return f ? { ...h, unread: !f.seen, starred: f.flagged, answered: f.answered } : h; });
    const freshKeys = new Set(fresh.map(h => h.key));
    headers = [...fresh, ...kept.filter(h => !freshKeys.has(h.key))];
  } else headers = fresh;
  const known = new Set(prev?.headers.map(h => h.key) ?? []);
  const sync: FolderSyncState = { uidValidity: res.uidValidity ?? undefined, uidNext: res.uidNext ?? undefined, exhausted: headers.length >= res.exists, lastSync: Date.now() };
  return { cache: { headers, sync }, newKeys: prev && !validityChanged ? fresh.filter(h => !known.has(h.key) && h.unread).map(h => h.key) : [] };
}

/** Rafraîchit un dossier (incrémental si possible). */
export async function refreshFolder(acc: MailAccount, folder: string, prev: FolderCache | undefined, lane?: string): Promise<RefreshResult> {
  if (acc.kind === 'gmail') {
    if (prev?.sync.historyId && prev.headers.length) {
      try { return await gmailIncremental(acc, folder, prev); }
      catch (e) { if (!(e instanceof HistoryExpiredError)) throw e; }
    }
    return gmailFull(acc, folder, prev);
  }
  return imapRefresh(acc, folder, prev, lane);
}

/** Page suivante (messages plus anciens). */
export async function loadMore(acc: MailAccount, folder: string, prev: FolderCache): Promise<FolderCache> {
  if (acc.kind === 'gmail') {
    if (!prev.sync.nextPageToken) return { ...prev, sync: { ...prev.sync, exhausted: true } };
    const list = await gmail.listThreads(acc, { labelId: folder, max: PAGE, pageToken: prev.sync.nextPageToken });
    const threads = await mapLimit(list.threads ?? [], 6, t => gmail.getThread(acc, t.id).catch(() => null));
    const known = new Set(prev.headers.map(h => h.key));
    const more = threads.flatMap(t => gmailThreadHeaders(acc, t, folder)).filter(h => !known.has(h.key));
    return { headers: [...prev.headers, ...more], sync: { ...prev.sync, nextPageToken: list.nextPageToken, exhausted: !list.nextPageToken } };
  }
  const minUid = prev.headers.reduce((m, h) => (h.uid && h.uid < m ? h.uid : m), Number.MAX_SAFE_INTEGER);
  if (minUid <= 1 || minUid === Number.MAX_SAFE_INTEGER) return { ...prev, sync: { ...prev.sync, exhausted: true } };
  const res = await imap.fetch(acc, folder, { beforeUid: minUid, limit: 50 });
  const more = res.messages.map(m => imapHeader(acc.id, folder, m));
  return { headers: [...prev.headers, ...more], sync: { ...prev.sync, exhausted: more.length < 50 } };
}

/** Tous les messages d'un fil Gmail (y compris mes réponses hors du dossier affiché). */
export async function gmailThread(acc: MailAccount, threadId: string): Promise<MailHeader[]> {
  return gmailThreadHeaders(acc, await gmail.getThread(acc, threadId), 'THREAD');
}

// ── Corps et pièces jointes ──
export async function fetchBody(acc: MailAccount, h: MailHeader): Promise<MailBody> {
  if (acc.kind === 'gmail') {
    const m = await gmail.getMessage(acc, h.providerId, 'full');
    const b = gmailBody(m);
    if (b.html && /cid:/i.test(b.html)) {
      const inline = b.attachments.filter(a => a.contentId && !a.data && a.size < 3_000_000).slice(0, 15);
      await mapLimit(inline, 4, async a => { try { a.data = await gmail.attachment(acc, h.providerId, a.id); } catch { /* image manquante */ } });
    }
    return { key: h.key, html: b.html, text: b.text, attachments: b.attachments, fetchedAt: Date.now() };
  }
  if (typeof h.uid !== 'number') throw new Error('Message IMAP sans identifiant.');
  const m = await imap.fetchMessage(acc, h.folder, h.uid, { attachmentData: 'inline' });
  return {
    key: h.key, html: m.html ?? undefined, text: m.text ?? '', bcc: (m.bcc ?? []).map(toAddr), listUnsubscribe: m.listUnsubscribe ?? undefined, fetchedAt: Date.now(),
    attachments: m.attachments.map<MailAttachment>(a => ({ id: String(a.index), name: a.name, mime: a.mime, size: a.size, contentId: a.contentId ?? undefined, inline: a.inline, data: a.data ?? undefined })),
  };
}

/** Contenu (base64) d'une pièce jointe. */
export async function attachmentData(acc: MailAccount, h: MailHeader, a: MailAttachment): Promise<string> {
  if (a.data) return a.data;
  if (acc.kind === 'gmail') return gmail.attachment(acc, h.providerId, a.id);
  const r = await imap.fetchAttachment(acc, h.folder, h.uid!, Number(a.id));
  if (!r.data) throw new Error('Pièce jointe vide.');
  return r.data;
}

/** Message brut (.eml) en base64. */
export async function rawMessage(acc: MailAccount, h: MailHeader): Promise<string> {
  if (acc.kind === 'gmail') return base64UrlToBase64((await gmail.getMessage(acc, h.providerId, 'raw')).raw ?? '');
  const m = await imap.fetchMessage(acc, h.folder, h.uid!, { attachmentData: 'none', includeRaw: true });
  return m.raw ?? '';
}

// ── Actions ──
export async function setRead(acc: MailAccount, hs: MailHeader[], read: boolean) {
  if (!hs.length) return;
  if (acc.kind === 'gmail') return gmail.batchModify(acc, hs.map(h => h.providerId), read ? [] : ['UNREAD'], read ? ['UNREAD'] : []);
  for (const [folder, g] of byFolder(hs)) await imap.setFlags(acc, folder, uids(g), read ? ['\\Seen'] : [], read ? [] : ['\\Seen']);
}
export async function setStarred(acc: MailAccount, hs: MailHeader[], starred: boolean) {
  if (!hs.length) return;
  if (acc.kind === 'gmail') return gmail.batchModify(acc, hs.map(h => h.providerId), starred ? ['STARRED'] : [], starred ? [] : ['STARRED']);
  for (const [folder, g] of byFolder(hs)) await imap.setFlags(acc, folder, uids(g), starred ? ['\\Flagged'] : [], starred ? [] : ['\\Flagged']);
}
export async function setAnswered(acc: MailAccount, hs: MailHeader[]) {
  if (acc.kind !== 'imap' || !hs.length) return;
  for (const [folder, g] of byFolder(hs)) await imap.setFlags(acc, folder, uids(g), ['\\Answered'], []);
}

async function imapTarget(acc: MailAccount, folders: MailFolder[], role: 'archive' | 'trash' | 'junk'): Promise<string | undefined> {
  const f = folderByRole(folders, role, acc.folders?.[role]) ?? (role === 'archive' ? folderByRole(folders, 'all') : undefined);
  if (f) return f.id;
  if (role === 'archive') return imap.createFolder(acc, 'Archives');
  return undefined;
}

export async function archive(acc: MailAccount, folders: MailFolder[], hs: MailHeader[], context: string) {
  if (acc.kind === 'gmail') {
    const remove = ['INBOX', ...(context !== 'INBOX' && !folders.find(f => f.id === context)?.system ? [context] : [])];
    for (const t of threadIds(hs)) await gmail.modifyThread(acc, t, [], remove);
    return;
  }
  const target = await imapTarget(acc, folders, 'archive');
  if (!target) throw new Error('Aucun dossier d’archives trouvé.');
  for (const [folder, g] of byFolder(hs)) if (folder !== target) await imap.move(acc, folder, uids(g), target);
}

/** Corbeille. Renvoie 'permanent' si les messages ont été supprimés définitivement (IMAP). */
export async function trash(acc: MailAccount, folders: MailFolder[], hs: MailHeader[], permanentAllowed: boolean): Promise<'trash' | 'permanent' | 'needs-confirm'> {
  if (acc.kind === 'gmail') {
    if (hs.every(h => h.labels?.includes('TRASH'))) throw new Error('Ce fil est déjà dans la corbeille : Gmail le supprimera définitivement après 30 jours.');
    for (const t of threadIds(hs)) await gmail.trashThread(acc, t);
    return 'trash';
  }
  const target = await imapTarget(acc, folders, 'trash');
  const permanent = hs.filter(h => !target || h.folder === target);
  if (permanent.length && !permanentAllowed) return 'needs-confirm';
  for (const [folder, g] of byFolder(hs)) {
    if (!target || folder === target) await imap.deleteForever(acc, folder, uids(g));
    else await imap.move(acc, folder, uids(g), target);
  }
  return permanent.length ? 'permanent' : 'trash';
}

export async function markSpam(acc: MailAccount, folders: MailFolder[], hs: MailHeader[]) {
  if (acc.kind === 'gmail') { for (const t of threadIds(hs)) await gmail.modifyThread(acc, t, ['SPAM'], ['INBOX']); return; }
  const target = await imapTarget(acc, folders, 'junk');
  if (!target) throw new Error('Aucun dossier « Indésirables » sur ce compte.');
  for (const [folder, g] of byFolder(hs)) if (folder !== target) await imap.move(acc, folder, uids(g), target);
}

export async function moveTo(acc: MailAccount, hs: MailHeader[], context: string, target: string) {
  if (acc.kind === 'gmail') {
    const remove = context && context !== ALL_MAIL && context !== 'STARRED' && context !== 'IMPORTANT' && context !== target ? [context] : [];
    for (const t of threadIds(hs)) await gmail.modifyThread(acc, t, [target], remove);
    return;
  }
  for (const [folder, g] of byFolder(hs)) if (folder !== target) await imap.move(acc, folder, uids(g), target);
}

// ── Recherche côté serveur ──
export async function searchRemote(acc: MailAccount, query: string, folder?: string): Promise<MailHeader[]> {
  if (acc.kind === 'gmail') {
    const list = await gmail.listThreads(acc, { q: query, max: 25, labelId: folder && folder !== ALL_MAIL ? folder : undefined });
    const threads = await mapLimit(list.threads ?? [], 6, t => gmail.getThread(acc, t.id).catch(() => null));
    return threads.flatMap(t => gmailThreadHeaders(acc, t, folder ?? ALL_MAIL));
  }
  const f = folder ?? 'INBOX';
  const r = await imap.search(acc, f, query, 60);
  return r.messages.map(m => imapHeader(acc.id, f, m));
}

// ── Envoi et brouillons ──
export interface OutgoingContent { html: string; text: string }

function mimeOf(acc: MailAccount, d: LocalDraft, c: OutgoingContent) {
  return buildMime({
    from: { name: acc.name, email: acc.email }, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject,
    text: c.text, html: c.html, inReplyTo: d.inReplyTo, references: d.references, attachments: d.attachments,
  });
}

/** Envoi effectif — appelé UNIQUEMENT depuis le bouton « Envoyer » après confirmAction. */
export async function sendDraft(acc: MailAccount, folders: MailFolder[], d: LocalDraft, c: OutgoingContent): Promise<{ warning?: string }> {
  if (acc.kind === 'gmail') {
    await gmail.send(acc, toGmailRaw(mimeOf(acc, d, c)), d.threadId);
    if (d.gmailDraftId) await gmail.deleteDraft(acc, d.gmailDraftId).catch(() => undefined);
    return {};
  }
  const r = await imap.send(acc, {
    from: { name: acc.name, email: acc.email }, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: c.text, html: c.html,
    inReplyTo: d.inReplyTo, references: d.references ?? [], attachments: d.attachments.map(a => ({ name: a.name, mime: a.mime, data: a.data })),
  });
  if (acc.saveSentCopy !== false) {
    const sent = folderByRole(folders, 'sent', acc.folders?.sent);
    if (!sent) return { warning: 'Message envoyé, mais aucun dossier « Envoyés » trouvé pour en garder une copie.' };
    try { await imap.append(acc, sent.id, r.raw, ['\\Seen']); }
    catch (e) { return { warning: `Message envoyé, mais la copie dans « Envoyés » a échoué : ${(e as Error).message}` }; }
  }
  return {};
}

/** Enregistre / met à jour le brouillon côté Gmail. Renvoie l'id du brouillon Gmail. */
export async function saveRemoteDraft(acc: MailAccount, d: LocalDraft, c: OutgoingContent): Promise<string | undefined> {
  if (acc.kind !== 'gmail') return undefined;
  const raw = toGmailRaw(mimeOf(acc, d, c));
  if (d.gmailDraftId) {
    try { return (await gmail.updateDraft(acc, d.gmailDraftId, raw, d.threadId)).id; }
    catch (e) { if (!/introuvable|404/.test((e as Error).message)) throw e; }
  }
  return (await gmail.createDraft(acc, raw, d.threadId)).id;
}
export async function deleteRemoteDraft(acc: MailAccount, d: LocalDraft) {
  if (acc.kind === 'gmail' && d.gmailDraftId) await gmail.deleteDraft(acc, d.gmailDraftId).catch(() => undefined);
}

/** Échantillon de mes mails envoyés (texte), pour apprendre mon ton. */
export async function sentSamples(acc: MailAccount, folders: MailFolder[], n = 15): Promise<string[]> {
  if (acc.kind === 'gmail') {
    const list = await gmail.listMessages(acc, { labelId: 'SENT', max: n });
    const msgs = await mapLimit(list.messages ?? [], 4, m => gmail.getMessage(acc, m.id, 'full').catch(() => null));
    return msgs.filter((m): m is NonNullable<typeof m> => !!m).map(m => { const b = gmailBody(m); return b.text || htmlToText(b.html ?? ''); }).filter(Boolean);
  }
  const sent = folderByRole(folders, 'sent', acc.folders?.sent);
  if (!sent) return [];
  const res = await imap.fetch(acc, sent.id, { limit: n, lane: 'sync' });
  const texts = await mapLimit(res.messages.slice(0, n), 3, async h => {
    try { const m = await imap.fetchMessage(acc, sent.id, h.uid, { attachmentData: 'none', lane: 'sync' }); return m.text || htmlToText(m.html ?? ''); }
    catch { return ''; }
  });
  return texts.filter(Boolean);
}
