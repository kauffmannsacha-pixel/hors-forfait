// Modèles de bases prêts à l'emploi pour un créateur YouTube.
import { allPages } from '../db/pages';
import type { DbViewType, ID, PropertyType, SortRule } from '../db/types';
import { createDatabaseRaw } from './mutations';
import { newId, type CalcFn, type ColorName, type PropDef, type ViewX } from './model';

interface TProp {
  key: string; name: string; type: PropertyType; options?: [string, ColorName][];
  numberFormat?: PropDef['numberFormat']; formula?: string; dateFormat?: PropDef['dateFormat'];
}
interface TView {
  name: string; type: DbViewType; groupBy?: string; dateProp?: string; endDateProp?: string;
  /** Propriétés visibles (hors titre). Absent = toutes. */
  show?: string[]; sorts?: [string, SortRule['dir']][]; calcs?: Record<string, CalcFn>;
  cover?: string; cardSize?: ViewX['cardSize']; zoom?: ViewX['zoom']; widths?: Record<string, number>;
}
export interface DatabaseTemplate { id: string; name: string; icon: string; description: string; properties: TProp[]; views: TView[] }

export const databaseTemplates: DatabaseTemplate[] = [
  {
    id: 'idees-video', name: 'Idées vidéo', icon: '🎬',
    description: 'Pipeline de production : de l’idée à la publication, avec calendrier et miniatures.',
    properties: [
      { key: 'title', name: 'Titre', type: 'title' },
      { key: 'statut', name: 'Statut', type: 'status', options: [['Idée', 'gray'], ['Script', 'blue'], ['Tournage', 'orange'], ['Montage', 'purple'], ['Publié', 'green']] },
      { key: 'date', name: 'Date de publication', type: 'date' },
      { key: 'chaine', name: 'Chaîne', type: 'select', options: [['Chaîne principale', 'red']] },
      { key: 'format', name: 'Format', type: 'select', options: [['Vidéo', 'blue'], ['Short', 'pink'], ['Live', 'orange']] },
      { key: 'lien', name: 'Lien vidéo', type: 'url' },
      { key: 'mini', name: 'Miniature', type: 'file' },
      { key: 'notes', name: 'Notes', type: 'text' },
    ],
    views: [
      { name: 'Pipeline', type: 'board', groupBy: 'statut', show: ['format', 'date', 'chaine'], cover: 'mini', cardSize: 'medium' },
      { name: 'Calendrier de publication', type: 'calendar', dateProp: 'date', show: ['statut'] },
      { name: 'Toutes les idées', type: 'table', sorts: [['date', 'asc']], widths: { title: 300 } },
      { name: 'Miniatures', type: 'gallery', cover: 'mini', show: ['statut', 'date'], cardSize: 'medium' },
    ],
  },
  {
    id: 'partenariats', name: 'Partenariats', icon: '🤝',
    description: 'Suivi des sponsors : négociation, livrables, montants et paiements.',
    properties: [
      { key: 'title', name: 'Marque', type: 'title' },
      { key: 'statut', name: 'Statut', type: 'status', options: [['Prospect', 'gray'], ['Contacté', 'blue'], ['Négociation', 'yellow'], ['Signé', 'purple'], ['Livré', 'orange'], ['Payé', 'green'], ['Refusé', 'red']] },
      { key: 'contact', name: 'Contact', type: 'text' },
      { key: 'email', name: 'E-mail', type: 'email' },
      { key: 'montant', name: 'Montant', type: 'number', numberFormat: 'euro' },
      { key: 'livrables', name: 'Livrables', type: 'multi_select', options: [['Intégration vidéo', 'blue'], ['Vidéo dédiée', 'purple'], ['Short', 'pink'], ['Story', 'orange'], ['Post', 'green']] },
      { key: 'livraison', name: 'Date de livraison', type: 'date' },
      { key: 'paye', name: 'Payé', type: 'checkbox' },
      { key: 'contrat', name: 'Contrat', type: 'file' },
      { key: 'lien', name: 'Lien', type: 'url' },
    ],
    views: [
      { name: 'Pipeline', type: 'board', groupBy: 'statut', show: ['montant', 'livraison', 'livrables'] },
      { name: 'Tous les partenariats', type: 'table', calcs: { montant: 'sum', paye: 'percent_checked' }, widths: { title: 220 } },
      { name: 'Livraisons', type: 'calendar', dateProp: 'livraison', show: ['statut'] },
    ],
  },
  {
    id: 'taches', name: 'Tâches', icon: '✅',
    description: 'Tâches de production avec priorités, échéances, responsables et planning.',
    properties: [
      { key: 'title', name: 'Tâche', type: 'title' },
      { key: 'statut', name: 'Statut', type: 'status', options: [['À faire', 'gray'], ['En cours', 'blue'], ['En attente', 'yellow'], ['Terminé', 'green']] },
      { key: 'priorite', name: 'Priorité', type: 'select', options: [['Haute', 'red'], ['Moyenne', 'yellow'], ['Basse', 'gray']] },
      { key: 'echeance', name: 'Échéance', type: 'date', dateFormat: 'relative' },
      { key: 'assigne', name: 'Assigné à', type: 'person' },
      { key: 'tags', name: 'Étiquettes', type: 'multi_select', options: [['Tournage', 'orange'], ['Montage', 'purple'], ['Réseaux', 'pink'], ['Admin', 'gray']] },
      { key: 'retard', name: 'En retard', type: 'formula', formula: 'prop("Statut") != "Terminé" and not empty(prop("Échéance")) and prop("Échéance") < today()' },
    ],
    views: [
      { name: 'Par statut', type: 'board', groupBy: 'statut', show: ['priorite', 'echeance', 'assigne'] },
      { name: 'Toutes les tâches', type: 'table', sorts: [['echeance', 'asc']], calcs: { retard: 'checked' } },
      { name: 'Par priorité', type: 'list', groupBy: 'priorite', show: ['statut', 'echeance', 'assigne'] },
      { name: 'Échéances', type: 'calendar', dateProp: 'echeance', show: ['statut'] },
      { name: 'Planning', type: 'timeline', dateProp: 'echeance', zoom: 'week', show: ['statut'] },
    ],
  },
  {
    id: 'contenu-reseaux', name: 'Contenu réseaux', icon: '📱',
    description: 'Calendrier éditorial TikTok, Instagram, Shorts, X… avec performances.',
    properties: [
      { key: 'title', name: 'Publication', type: 'title' },
      { key: 'plateforme', name: 'Plateformes', type: 'multi_select', options: [['TikTok', 'default'], ['Instagram', 'pink'], ['YouTube Shorts', 'red'], ['X', 'gray'], ['LinkedIn', 'blue'], ['Discord', 'purple']] },
      { key: 'statut', name: 'Statut', type: 'status', options: [['Idée', 'gray'], ['À produire', 'yellow'], ['Programmé', 'blue'], ['Publié', 'green']] },
      { key: 'date', name: 'Date de publication', type: 'date' },
      { key: 'legende', name: 'Légende', type: 'text' },
      { key: 'visuel', name: 'Visuel', type: 'file' },
      { key: 'lien', name: 'Lien', type: 'url' },
      { key: 'vues', name: 'Vues', type: 'number' },
      { key: 'likes', name: 'J’aime', type: 'number' },
      { key: 'engagement', name: 'Engagement', type: 'formula', numberFormat: 'percent', formula: 'if(prop("Vues") > 0, round(prop("J’aime") / prop("Vues") * 100, 1), toNumber(""))' },
    ],
    views: [
      { name: 'Calendrier', type: 'calendar', dateProp: 'date', show: ['plateforme', 'statut'] },
      { name: 'Production', type: 'board', groupBy: 'statut', show: ['plateforme', 'date'], cover: 'visuel' },
      { name: 'Visuels', type: 'gallery', cover: 'visuel', show: ['plateforme', 'date'], cardSize: 'small' },
      { name: 'Performances', type: 'table', sorts: [['date', 'desc']], calcs: { vues: 'sum', likes: 'sum', engagement: 'avg' } },
    ],
  },
  {
    id: 'depenses', name: 'Dépenses', icon: '💸',
    description: 'Dépenses de la chaîne : catégories, justificatifs, TVA et totaux.',
    properties: [
      { key: 'title', name: 'Dépense', type: 'title' },
      { key: 'montant', name: 'Montant', type: 'number', numberFormat: 'euro' },
      { key: 'categorie', name: 'Catégorie', type: 'select', options: [['Matériel', 'blue'], ['Logiciels', 'purple'], ['Montage', 'orange'], ['Déplacements', 'yellow'], ['Marketing', 'pink'], ['Sous-traitance', 'brown'], ['Autre', 'gray']] },
      { key: 'date', name: 'Date', type: 'date' },
      { key: 'paye', name: 'Payée', type: 'checkbox' },
      { key: 'moyen', name: 'Moyen de paiement', type: 'select', options: [['Carte', 'blue'], ['Virement', 'green'], ['PayPal', 'yellow'], ['Espèces', 'gray']] },
      { key: 'justificatif', name: 'Justificatif', type: 'file' },
      { key: 'tva', name: 'TVA (20 %)', type: 'formula', numberFormat: 'euro', formula: 'if(empty(prop("Montant")), toNumber(""), round(prop("Montant") - prop("Montant") / 1.2, 2))' },
      { key: 'mois', name: 'Mois', type: 'formula', formula: 'formatDate(prop("Date"), "MMMM yyyy")' },
    ],
    views: [
      { name: 'Toutes les dépenses', type: 'table', sorts: [['date', 'desc']], calcs: { montant: 'sum', tva: 'sum', paye: 'percent_checked' } },
      { name: 'Par catégorie', type: 'table', groupBy: 'categorie', calcs: { montant: 'sum' } },
      { name: 'Board', type: 'board', groupBy: 'categorie', show: ['montant', 'date'] },
      { name: 'Calendrier', type: 'calendar', dateProp: 'date', show: ['montant'] },
    ],
  },
];

/** Crée une base à partir d'un modèle ; renvoie l'id de la base. */
export async function createFromTemplate(id: string, parentId?: ID | null): Promise<ID> {
  const t = databaseTemplates.find(x => x.id === id);
  if (!t) throw new Error(`Modèle de base introuvable : « ${id} »`);
  const ids: Record<string, string> = {};
  for (const p of t.properties) ids[p.key] = p.type === 'title' ? 'title' : newId();
  const properties: PropDef[] = t.properties.map(p => ({
    id: ids[p.key], name: p.name, type: p.type,
    ...(p.options ? { options: p.options.map(([name, color]) => ({ id: newId(), name, color })) } : {}),
    ...(p.numberFormat ? { numberFormat: p.numberFormat } : {}),
    ...(p.formula !== undefined ? { formula: p.formula } : {}),
    ...(p.dateFormat ? { dateFormat: p.dateFormat } : {}),
  }));
  const keyOf = (propId: string) => t.properties.find(p => ids[p.key] === propId)?.key ?? '';
  const views: ViewX[] = t.views.map(v => ({
    id: newId(), name: v.name, type: v.type, filters: [],
    sorts: (v.sorts ?? []).map(([k, dir]) => ({ propId: ids[k], dir })),
    ...(v.groupBy ? { groupBy: ids[v.groupBy] } : {}),
    ...(v.dateProp ? { dateProp: ids[v.dateProp] } : {}),
    ...(v.endDateProp ? { endDateProp: ids[v.endDateProp] } : {}),
    hiddenProps: v.show ? properties.filter(p => p.id !== 'title' && !v.show!.includes(keyOf(p.id))).map(p => p.id) : [],
    ...(v.calcs ? { calcs: Object.fromEntries(Object.entries(v.calcs).map(([k, fn]) => [ids[k], fn])) } : {}),
    ...(v.cover ? { cover: v.cover === 'page' || v.cover === 'none' ? v.cover : ids[v.cover] } : {}),
    ...(v.cardSize ? { cardSize: v.cardSize } : {}),
    ...(v.zoom ? { zoom: v.zoom } : {}),
    ...(v.widths ? { widths: Object.fromEntries(Object.entries(v.widths).map(([k, w]) => [ids[k], w])) } : {}),
  }));
  return createDatabaseRaw({ title: t.name, icon: t.icon, parentId: parentId ?? null, properties, views, meta: { template: t.id, description: t.description } });
}

/** Base issue d'un modèle (la crée au besoin) — pratique pour le Studio (« Idées vidéo »). */
export async function ensureFromTemplate(id: string): Promise<ID> {
  const found = allPages().find(p => p.kind === 'database' && !p.trashed && p.meta?.template === id);
  return found ? found.id : createFromTemplate(id);
}
