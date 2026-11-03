// Comptes mail : persistance (repo kv), préréglages IMAP/SMTP, mots de passe dans le coffre.
import { repo, uid } from '../db/store';
import { secrets } from '../db/secrets';
import type { MailAccount, Security } from './types';
import { normEmail } from './util';

export interface Preset {
  id: string;
  label: string;
  domains: string[];
  imap: { host: string; port: number; security: Security };
  smtp: { host: string; port: number; security: Security };
  /** Identifiant de connexion : adresse complète ou partie avant @. */
  username: 'email' | 'local';
  hint: string;
  /** Page officielle pour créer un mot de passe d'application. */
  appPasswordUrl?: string;
  /** Copie des envois dans « Envoyés » (le serveur ne le fait pas lui-même). */
  saveSentCopy: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: 'outlook', label: 'Outlook / Hotmail', domains: ['outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    username: 'email', saveSentCopy: false, appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    hint: "Active l'accès IMAP dans Outlook.com (Paramètres → Courrier → Transfert et IMAP). Avec la validation en deux étapes, utilise un mot de passe d'application.",
  },
  {
    id: 'yahoo', label: 'Yahoo Mail', domains: ['yahoo.com', 'yahoo.fr', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' },
    username: 'email', saveSentCopy: false, appPasswordUrl: 'https://login.yahoo.com/account/security',
    hint: "Yahoo exige un mot de passe d'application : Compte Yahoo → Sécurité du compte → Générer un mot de passe d'application.",
  },
  {
    id: 'icloud', label: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    username: 'email', saveSentCopy: true, appPasswordUrl: 'https://account.apple.com/account/manage',
    hint: 'iCloud exige un mot de passe pour app : compte Apple → Connexion et sécurité → Mots de passe pour app.',
  },
  {
    id: 'ovh', label: 'OVHcloud (MX Plan)', domains: [],
    imap: { host: 'ssl0.ovh.net', port: 993, security: 'ssl' }, smtp: { host: 'ssl0.ovh.net', port: 465, security: 'ssl' },
    username: 'email', saveSentCopy: true,
    hint: "Identifiant : l'adresse complète. Offre E-mail Pro : serveur pro1.mail.ovh.net (SMTP 587, STARTTLS) — modifiable dans « Réglages avancés ».",
  },
  {
    id: 'orange', label: 'Orange', domains: ['orange.fr', 'wanadoo.fr'],
    imap: { host: 'imap.orange.fr', port: 993, security: 'ssl' }, smtp: { host: 'smtp.orange.fr', port: 465, security: 'ssl' },
    username: 'email', saveSentCopy: true,
    hint: "Identifiant : l'adresse complète et le mot de passe de ta messagerie Orange.",
  },
  {
    id: 'free', label: 'Free', domains: ['free.fr'],
    imap: { host: 'imap.free.fr', port: 993, security: 'ssl' }, smtp: { host: 'smtp.free.fr', port: 465, security: 'ssl' },
    username: 'local', saveSentCopy: true,
    hint: "Identifiant : la partie avant « @free.fr ». Pense à activer l'envoi authentifié (SMTP) dans ton espace abonné si besoin.",
  },
  {
    id: 'custom', label: 'Autre fournisseur (personnalisé)', domains: [],
    imap: { host: '', port: 993, security: 'ssl' }, smtp: { host: '', port: 465, security: 'ssl' },
    username: 'email', saveSentCopy: true,
    hint: 'Renseigne les serveurs IMAP (réception) et SMTP (envoi) indiqués par ton fournisseur.',
  },
];

export const presetById = (id?: string) => PRESETS.find(p => p.id === id);
export function presetForEmail(email: string): Preset | undefined {
  const domain = normEmail(email).split('@')[1] ?? '';
  return PRESETS.find(p => p.domains.includes(domain));
}
export const isGmailAddress = (email: string) => /@(gmail|googlemail)\.com$/i.test(email.trim());
export const usernameFor = (p: Preset, email: string) => (p.username === 'local' ? email.trim().split('@')[0] : email.trim());

export const ACCOUNT_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68'];

const KEY = 'mail.accounts';
export async function loadAccounts(): Promise<MailAccount[]> {
  const list = (await repo.kvGet<MailAccount[]>(KEY).catch(() => undefined)) ?? [];
  return Array.isArray(list) ? list.filter(a => a && a.id && a.email) : [];
}
export const saveAccounts = (list: MailAccount[]) => repo.kvSet(KEY, list);

const pwdKey = (id: string, smtp = false) => `mail.${smtp ? 'smtp' : 'imap'}.password.${id}`;
export const getPassword = async (id: string, smtp = false) => (await secrets.get(pwdKey(id, smtp))) ?? '';
export const setPassword = (id: string, value: string, smtp = false) => secrets.set(pwdKey(id, smtp), value);
export async function deleteAccountSecrets(id: string) { await secrets.del(pwdKey(id)); await secrets.del(pwdKey(id, true)); }

export function newAccountId() { return 'acc_' + uid().replace(/-/g, '').slice(0, 12); }

/** Adresses considérées comme « moi » (compte + alias). */
export const myAddresses = (accounts: MailAccount[]) => accounts.flatMap(a => [a.email, ...(a.aliases ?? [])]).map(normEmail);
