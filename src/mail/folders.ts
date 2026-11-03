// Dossiers : rôles (détection par nom si le serveur n'annonce pas SPECIAL-USE), tri, libellés (pur).
import type { FolderRole, MailFolder } from './types';
import { fold } from './util';

export const ROLE_NAMES: Record<FolderRole, string> = {
  inbox: 'Réception', flagged: 'Suivis', important: 'Importants', drafts: 'Brouillons', sent: 'Envoyés',
  archive: 'Archives', all: 'Tous les messages', junk: 'Indésirables', trash: 'Corbeille',
};

const NAME_ROLES: [FolderRole, RegExp][] = [
  ['sent', /^(sent|sent items|sent messages|sent mail|envoyes|elements envoyes|messages envoyes|courrier envoye|gesendet|enviados)$/],
  ['drafts', /^(drafts?|brouillons?|entwurfe|borradores)$/],
  ['trash', /^(trash|deleted|deleted items|deleted messages|bin|corbeille|elements supprimes|messages supprimes|papierkorb|papelera)$/],
  ['junk', /^(junk|junk e-?mail|junk mail|spam|bulk mail|courrier indesirable|indesirables?|pourriel|spams?)$/],
  ['archive', /^(archives?|archiv|archivo)$/],
  ['all', /^(all mail|tous les messages)$/],
];

/** Rôle d'un dossier d'après son nom (dernier segment ou chemin complet). */
export function guessRole(path: string, name: string): FolderRole | undefined {
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  const n = fold(name).replace(/[^a-z0-9 -]/g, '').trim();
  for (const [role, re] of NAME_ROLES) if (re.test(n)) return role;
  return undefined;
}

const ORDER: FolderRole[] = ['inbox', 'flagged', 'important', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];

/** Tri à la Apple Mail : dossiers spéciaux d'abord (avec leurs sous-dossiers), puis les autres par chemin. */
export function sortFolders(list: MailFolder[]): MailFolder[] {
  const roleRank = (f: MailFolder) => (f.role ? ORDER.indexOf(f.role) : ORDER.length);
  const rootOf = (f: MailFolder) => list
    .filter(p => p !== f && p.role && (f.id.startsWith(p.id + '/') || f.id.startsWith(p.id + '.')))
    .sort((a, b) => a.id.length - b.id.length)[0];
  const rank = (f: MailFolder) => { const r = f.role ? f : rootOf(f); return r ? roleRank(r) : ORDER.length; };
  return [...list].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, 'fr', { sensitivity: 'base' }));
}

/** Dossier d'un rôle donné (choix explicite du compte en priorité). */
export function folderByRole(folders: MailFolder[] | undefined, role: FolderRole, explicit?: string): MailFolder | undefined {
  if (explicit) { const f = folders?.find(x => x.id === explicit); if (f) return f; }
  return folders?.find(f => f.role === role && f.selectable);
}

export const folderLabel = (f: MailFolder) => (f.role && f.depth === 0 && f.role !== 'inbox' ? ROLE_NAMES[f.role] : f.role === 'inbox' ? 'Réception' : f.name);
