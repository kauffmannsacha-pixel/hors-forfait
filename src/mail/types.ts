// Types du module Mail (Gmail via API REST + IMAP/SMTP via les commandes Rust de mail.rs).

export type AccountKind = 'gmail' | 'imap';
export type Security = 'ssl' | 'starttls' | 'none';

export interface MailAddress { name?: string; email: string }

export interface ServerSettings { host: string; port: number; security: Security; username: string }

export interface Signature { json: unknown; html: string }

export interface MailAccount {
  id: string;
  kind: AccountKind;
  email: string;
  /** Nom affiché comme expéditeur. */
  name: string;
  color: string;
  /** Compte Google (connecteur) pour Gmail. */
  googleAccountId?: string;
  /** IMAP/SMTP : le mot de passe est dans le coffre (`secrets`), jamais ici. */
  imap?: ServerSettings;
  smtp?: ServerSettings;
  preset?: string;
  /** Mot de passe SMTP distinct de celui d'IMAP. */
  smtpOwnPassword?: boolean;
  acceptInvalidCerts?: boolean;
  /** Copie des messages envoyés dans le dossier « Envoyés » (IMAP). */
  saveSentCopy?: boolean;
  /** Dossiers IMAP choisis (sinon détection automatique). */
  folders?: Partial<Record<'sent' | 'drafts' | 'trash' | 'junk' | 'archive', string>>;
  signature?: Signature;
  /** Autres adresses à moi (exclues de « Répondre à tous »). */
  aliases?: string[];
  createdAt: number;
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | 'important';

export interface MailFolder {
  accountId: string;
  /** Gmail : id de libellé (INBOX, Label_12…) ; IMAP : chemin brut. Gmail « Tous les messages » = '__ALL__'. */
  id: string;
  name: string;
  role?: FolderRole;
  unread?: number;
  total?: number;
  selectable: boolean;
  depth: number;
  color?: string;
  /** Libellé/dossier système (non supprimable, ordre fixe). */
  system?: boolean;
}

export interface MailHeader {
  /** Clé unique : `${accountId}|${providerId}` (Gmail : id du message ; IMAP : `${dossier}|${uid}`). */
  key: string;
  accountId: string;
  /** Gmail : id du message ; IMAP : uid (texte). */
  providerId: string;
  /** Dossier d'origine (IMAP) / libellé de contexte (Gmail). */
  folder: string;
  uid?: number;
  threadId?: string;
  /** Message-ID RFC 5322, sans chevrons. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo?: MailAddress[];
  date: number;
  snippet: string;
  unread: boolean;
  starred: boolean;
  answered?: boolean;
  draft?: boolean;
  labels?: string[];
  hasAttachments: boolean;
  size?: number;
}

export interface MailAttachment {
  /** Gmail : attachmentId ; IMAP : index (texte). */
  id: string;
  name: string;
  mime: string;
  size: number;
  contentId?: string;
  inline?: boolean;
  /** Base64 standard, si déjà chargé. */
  data?: string;
}

export interface MailBody {
  key: string;
  html?: string;
  text: string;
  attachments: MailAttachment[];
  bcc?: MailAddress[];
  listUnsubscribe?: string;
  fetchedAt: number;
}

export interface MailThread {
  key: string;
  accountId: string;
  subject: string;
  /** Messages du plus ancien au plus récent. */
  messages: MailHeader[];
  lastDate: number;
  unread: number;
  starred: boolean;
  hasAttachments: boolean;
  participants: MailAddress[];
  snippet: string;
  latest: MailHeader;
}

export interface MailCategory { id: string; name: string; color: string; description: string }

export interface TriageResult { category: string; urgent: boolean; reason?: string; at: number }

export interface DraftAttachment { name: string; mime: string; size: number; data: string }

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface LocalDraft {
  id: string;
  accountId: string;
  mode: ComposeMode;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** Contenu de l'éditeur (JSON TipTap). */
  json: unknown;
  html: string;
  text: string;
  attachments: DraftAttachment[];
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  /** Message auquel on répond (clé MailHeader). */
  replyToKey?: string;
  /** Citation (réponse) ou message transféré, déjà nettoyés. */
  quoteHtml?: string;
  quoteText?: string;
  gmailDraftId?: string;
  updatedAt: number;
  createdAt: number;
}

export type MailboxSel =
  | { type: 'unified' }
  | { type: 'smart'; id: 'urgent' | 'unread' | 'starred' }
  | { type: 'category'; id: string }
  | { type: 'folder'; accountId: string; folderId: string }
  | { type: 'drafts' };

export interface FolderSyncState {
  /** Gmail : historyId de départ pour l'incrémental. */
  historyId?: string;
  nextPageToken?: string;
  /** IMAP */
  uidValidity?: number;
  uidNext?: number;
  exhausted?: boolean;
  lastSync?: number;
}

export interface FolderCache { headers: MailHeader[]; sync: FolderSyncState }

export interface StyleProfile {
  summary: string;
  greeting: string;
  signOff: string;
  formality: string;
  examples: string[];
  sampleCount: number;
  at: number;
}

export interface MailSettings {
  syncIntervalMin: number;
  notifyUrgent: boolean;
  notifyAll: boolean;
  autoTriage: boolean;
  showRemoteImages: boolean;
  trustedSenders: string[];
  categories: MailCategory[];
  /** Instructions de ton supplémentaires pour les brouillons de Claude. */
  toneNotes: string;
}

export interface SearchHit {
  threadKey: string;
  key: string;
  accountId: string;
  account: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  category?: string;
  urgent?: boolean;
}
