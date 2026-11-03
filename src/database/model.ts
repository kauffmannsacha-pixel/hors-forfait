// Modèle interne du module bases de données.
// Les types partagés (src/db/types.ts) sont étendus ici par des champs OPTIONNELS
// (persistés tels quels dans le JSON du schéma) sans modifier le contrat.
import type { DatabaseSchema, DbView, DbViewType, ID, PropertyDef, PropertyType, SelectOption } from '../db/types';

export type CalcFn =
  | 'none' | 'count_all' | 'count_values' | 'count_unique' | 'count_empty' | 'count_not_empty'
  | 'percent_empty' | 'percent_not_empty' | 'sum' | 'avg' | 'median' | 'min' | 'max' | 'range'
  | 'checked' | 'unchecked' | 'percent_checked' | 'earliest' | 'latest' | 'date_range';

export type DateFormat = 'short' | 'full' | 'dmy' | 'mdy' | 'iso' | 'relative';

/** Définition de propriété enrichie (compatible PropertyDef). */
export interface PropDef extends PropertyDef {
  /** relation : base cible + id de la propriété miroir (relation bidirectionnelle). */
  relation?: { databaseId: ID; syncedPropId?: string };
  decimals?: number;                       // nombre : décimales forcées
  showAs?: 'number' | 'bar' | 'ring';      // nombre : affichage
  divideBy?: number;                       // nombre : base de la barre / de l'anneau
  dateFormat?: DateFormat;
  timeFormat?: '24h' | '12h';
  description?: string;
}

/** Vue enrichie (compatible DbView). */
export interface ViewX extends DbView {
  propOrder?: string[];                    // ordre des propriétés dans la vue
  calcs?: Record<string, CalcFn>;          // tableau : ligne de calcul
  collapsed?: string[];                    // groupes repliés
  hiddenGroups?: string[];                 // board : colonnes masquées
  hideEmptyGroups?: boolean;
  cover?: string;                          // galerie/board : 'none' | 'page' | id d'une propriété fichier/URL
  cardSize?: 'small' | 'medium' | 'large';
  fitImage?: boolean;
  zoom?: 'day' | 'week' | 'month';         // timeline
  wrap?: boolean;                          // tableau : retour à la ligne
}

export interface Schema extends DatabaseSchema { properties: PropDef[]; views: ViewX[] }

/** Référence de fichier stockée dans une propriété « fichier ». */
export interface FileRef { hash?: string; url?: string; name: string; mime?: string }
/** Date stockée : 'yyyy-MM-dd' | "yyyy-MM-dd'T'HH:mm" | { start, end }. */
export interface DateValue { start: string; end?: string | null }
/** Personne locale (kv 'people'). */
export interface Person { id: string; name: string; color: string; email?: string }

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

// ── Types de propriétés ──────────────────────────────────────
export const TYPE_LABELS: Record<PropertyType, string> = {
  title: 'Titre', text: 'Texte', number: 'Nombre', select: 'Sélection', multi_select: 'Sélection multiple',
  status: 'Statut', date: 'Date', person: 'Personne', checkbox: 'Case à cocher', url: 'URL', email: 'E-mail',
  phone: 'Téléphone', file: 'Fichiers et médias', relation: 'Relation', rollup: 'Rollup', formula: 'Formule',
  created_time: 'Créé le', updated_time: 'Modifié le',
};
/** Ordre d'affichage dans les menus « type ». */
export const PROPERTY_TYPES: PropertyType[] = [
  'text', 'number', 'select', 'multi_select', 'status', 'date', 'person', 'checkbox', 'url', 'email', 'phone',
  'file', 'relation', 'rollup', 'formula', 'created_time', 'updated_time',
];
export const COMPUTED_TYPES: PropertyType[] = ['formula', 'rollup', 'created_time', 'updated_time'];
export const isComputed = (t: PropertyType) => COMPUTED_TYPES.includes(t);
export const isSelectLike = (t: PropertyType) => t === 'select' || t === 'status' || t === 'multi_select';
export const isTextLike = (t: PropertyType) => t === 'title' || t === 'text' || t === 'url' || t === 'email' || t === 'phone';

// ── Vues ─────────────────────────────────────────────────────
export const VIEW_LABELS: Record<DbViewType, string> = {
  table: 'Tableau', board: 'Board', calendar: 'Calendrier', gallery: 'Galerie', list: 'Liste', timeline: 'Timeline',
};
export const VIEW_TYPES: DbViewType[] = ['table', 'board', 'calendar', 'gallery', 'list', 'timeline'];

// ── Couleurs Notion ──────────────────────────────────────────
export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type ColorName = typeof COLORS[number];
export const COLOR_LABELS: Record<ColorName, string> = {
  default: 'Par défaut', gray: 'Gris', brown: 'Marron', orange: 'Orange', yellow: 'Jaune', green: 'Vert',
  blue: 'Bleu', purple: 'Violet', pink: 'Rose', red: 'Rouge',
};
const CYCLE: ColorName[] = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray'];
/** Prochaine couleur libre (rotation façon Notion). */
export function nextColor(used: (string | undefined)[]): ColorName {
  for (const c of CYCLE) if (!used.includes(c)) return c;
  return CYCLE[used.length % CYCLE.length];
}
export const colorOf = (c?: string): ColorName => ((COLORS as readonly string[]).includes(c ?? '') ? c as ColorName : 'default');

export const DEFAULT_STATUS: Omit<SelectOption, 'id'>[] = [
  { name: 'À faire', color: 'gray' }, { name: 'En cours', color: 'blue' }, { name: 'Terminé', color: 'green' },
];

/** Nom unique (« Texte », « Texte 2 »…). */
export function uniqueName(base: string, taken: string[]): string {
  const low = taken.map(t => t.toLowerCase());
  if (!low.includes(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!low.includes(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Ordre des propriétés pour une vue (propOrder puis ordre du schéma). */
export function orderedProps(schema: Schema, view?: ViewX): PropDef[] {
  const order = view?.propOrder ?? [];
  const byId = new Map(schema.properties.map(p => [p.id, p]));
  const out: PropDef[] = [];
  for (const id of order) { const p = byId.get(id); if (p) { out.push(p); byId.delete(id); } }
  for (const p of schema.properties) if (byId.has(p.id)) out.push(p);
  return out;
}
export const visibleProps = (schema: Schema, view: ViewX) =>
  orderedProps(schema, view).filter(p => !(view.hiddenProps ?? []).includes(p.id));

export const findProp = (schema: Schema | undefined, idOrName: string): PropDef | undefined => {
  if (!schema) return undefined;
  const key = idOrName.trim().toLowerCase();
  return schema.properties.find(p => p.id === idOrName) ?? schema.properties.find(p => p.name === idOrName)
    ?? schema.properties.find(p => p.name.trim().toLowerCase() === key);
};

export const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
