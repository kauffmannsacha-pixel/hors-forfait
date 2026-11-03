// Regroupement des messages en fils de discussion (pur, testé).
// Gmail : par threadId. IMAP : par chaîne Message-ID / In-Reply-To / References (union-find),
// puis par sujet normalisé pour les réponses sans en-têtes de référence.
import type { MailAddress, MailHeader, MailThread } from './types';
import { hasReplyPrefix, normEmail, normalizeSubject } from './util';

/** Fenêtre max pour rattacher une réponse « Re: » sans références à un fil par son sujet. */
const SUBJECT_WINDOW_MS = 45 * 86400_000;

const normId = (id?: string) => (id ?? '').trim().replace(/^<|>$/g, '').toLowerCase();

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) { const next = this.parent.get(cur)!; this.parent.set(cur, root); cur = next; }
    return root;
  }
  union(a: string, b: string) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.parent.set(rb, ra); }
}

/** Clé de fil stable : Gmail `acc|t|threadId`, sinon `acc|r|<id racine>`. */
export function threadKeyFor(accountId: string, root: string, gmail: boolean) {
  return `${accountId}|${gmail ? 't' : 'r'}|${root}`;
}

/**
 * Regroupe des en-têtes en fils. Les messages d'un même compte seulement.
 * Les doublons (même message vu dans deux dossiers) sont fusionnés.
 */
export function groupThreads(headers: MailHeader[]): MailThread[] {
  // 1) dédoublonnage : même clé, ou même Message-ID dans le même compte (copie dans un autre dossier)
  const unique = new Map<string, MailHeader>();
  const byMsgId = new Map<string, string>();
  for (const h of headers) {
    if (unique.has(h.key)) continue;
    const mid = normId(h.messageId);
    const dupKey = mid ? `${h.accountId}|${mid}` : '';
    if (dupKey && byMsgId.has(dupKey)) {
      // garde la version la plus « parlante » (non lue/étoilée prioritaire pour ne rien perdre)
      const prevKey = byMsgId.get(dupKey)!; const prev = unique.get(prevKey)!;
      if (prev.folder !== h.folder && /inbox/i.test(h.folder) && !/inbox/i.test(prev.folder)) { unique.delete(prevKey); unique.set(h.key, h); byMsgId.set(dupKey, h.key); }
      continue;
    }
    unique.set(h.key, h);
    if (dupKey) byMsgId.set(dupKey, h.key);
  }
  const list = [...unique.values()];

  const uf = new UnionFind();
  const node = (h: MailHeader) => `m:${h.key}`;
  for (const h of list) {
    const n = node(h); uf.find(n);
    if (h.threadId) { uf.union(`g:${h.accountId}|${h.threadId}`, n); continue; }
    const ids = [h.messageId, h.inReplyTo, ...(h.references ?? [])].map(normId).filter(Boolean);
    for (const id of ids) uf.union(n, `i:${h.accountId}|${id}`);
  }

  // 2) réponses sans références : rattachement par sujet normalisé (même compte, fenêtre de temps)
  const bySubject = new Map<string, MailHeader[]>();
  for (const h of list) {
    if (h.threadId) continue;
    const s = normalizeSubject(h.subject).toLowerCase(); if (!s) continue;
    const k = `${h.accountId}|${s}`;
    const arr = bySubject.get(k); if (arr) arr.push(h); else bySubject.set(k, [h]);
  }
  for (const arr of bySubject.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.date - b.date);
    for (let i = 1; i < arr.length; i++) {
      const h = arr[i];
      const hasRefs = !!(h.inReplyTo || h.references?.length);
      if (hasRefs || !hasReplyPrefix(h.subject)) continue;
      // rattache au message précédent de même sujet s'il est assez récent
      if (h.date - arr[i - 1].date <= SUBJECT_WINDOW_MS) uf.union(node(arr[i - 1]), node(h));
    }
  }

  // 3) construction des fils
  const groups = new Map<string, MailHeader[]>();
  for (const h of list) {
    const r = uf.find(node(h));
    const g = groups.get(r); if (g) g.push(h); else groups.set(r, [h]);
  }
  const threads: MailThread[] = [];
  for (const msgs of groups.values()) {
    msgs.sort((a, b) => a.date - b.date || a.key.localeCompare(b.key));
    const first = msgs[0]; const latest = msgs[msgs.length - 1];
    const gmail = !!first.threadId;
    const root = gmail ? first.threadId! : (normId(first.references?.[0]) || normId(first.inReplyTo) || normId(first.messageId) || first.key);
    const seen = new Set<string>(); const participants: MailAddress[] = [];
    for (const m of msgs) for (const a of [m.from]) {
      const k = normEmail(a?.email ?? ''); if (!k || seen.has(k)) continue; seen.add(k); participants.push(a);
    }
    const subjectSource = msgs.find(m => !hasReplyPrefix(m.subject) && m.subject.trim()) ?? first;
    threads.push({
      key: threadKeyFor(first.accountId, root, gmail),
      accountId: first.accountId,
      subject: normalizeSubject(subjectSource.subject) || subjectSource.subject || '(sans objet)',
      messages: msgs,
      lastDate: latest.date,
      unread: msgs.filter(m => m.unread).length,
      starred: msgs.some(m => m.starred),
      hasAttachments: msgs.some(m => m.hasAttachments),
      participants,
      snippet: latest.snippet,
      latest,
    });
  }
  threads.sort((a, b) => b.lastDate - a.lastDate || a.key.localeCompare(b.key));
  return threads;
}

/** Fil contenant un message donné, parmi un ensemble d'en-têtes (ex. Réception + Envoyés). */
export function threadOf(key: string, headers: MailHeader[]): MailThread | undefined {
  return groupThreads(headers).find(t => t.messages.some(m => m.key === key));
}

/** Noms courts des participants pour la liste (« Moi, Léa, Nike »). */
export function participantLabel(t: MailThread, myEmails: string[]): string {
  const mine = new Set(myEmails.map(normEmail));
  const names = t.participants.map(p => (mine.has(normEmail(p.email)) ? 'Moi' : (p.name?.split(/\s+/)[0] || p.email.split('@')[0])));
  const uniq = [...new Set(names)];
  if (uniq.length <= 3) return uniq.join(', ');
  return `${uniq.slice(0, 2).join(', ')} +${uniq.length - 2}`;
}
