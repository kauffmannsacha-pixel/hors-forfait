// ─────────────────────────────────────────────────────────────
// CONTRATS PARTAGÉS — tous les modules s'appuient dessus.
// On peut AJOUTER des champs optionnels, jamais en retirer/renommer.
// ─────────────────────────────────────────────────────────────
export type ID = string;

export type PageKind = 'page' | 'database' | 'script' | 'studio' | 'thumbnail' | 'stats';

export interface Page {
  id: ID;
  parentId: ID | null;          // une ligne de base de données a parentId = id de la base
  title: string;
  icon?: string;                // emoji
  cover?: string;
  content: unknown;             // JSON TipTap (doc)
  props?: Record<string, unknown>; // valeurs des propriétés si la page est une ligne de base
  favorite: boolean;
  trashed: boolean;
  kind: PageKind;
  createdAt: number;
  updatedAt: number;
  order: number;
  meta?: Record<string, unknown>; // données libres propres à un module (ex. script: idée, durée…)
}

export interface PageVersion { id: ID; pageId: ID; content: unknown; title: string; at: number }

export interface VaultFile {
  hash: string;     // sha256 (identifiant)
  name: string;
  mime: string;
  size: number;
  path: string;     // chemin absolu (dans /vault si copié, d'origine si lié)
  linked: boolean;  // true = lié (non copié)
  missing?: boolean; // fichier lié introuvable (déplacé/supprimé)
  addedAt: number;
}

// ── Bases de données (modèle Notion : une ligne = une Page avec props) ──
export type PropertyType =
  | 'title' | 'text' | 'number' | 'select' | 'multi_select' | 'status' | 'date' | 'person'
  | 'checkbox' | 'url' | 'email' | 'phone' | 'file' | 'relation' | 'rollup' | 'formula'
  | 'created_time' | 'updated_time';

export interface SelectOption { id: string; name: string; color: string }

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  options?: SelectOption[];                 // select / multi_select / status
  numberFormat?: 'number' | 'percent' | 'euro' | 'dollar';
  relation?: { databaseId: ID };            // relation
  rollup?: { relationPropId: string; targetPropId: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'show' };
  formula?: string;                         // expression (syntaxe type Notion)
}

export type DbViewType = 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'timeline';
export interface FilterRule { propId: string; op: string; value?: unknown }
export interface SortRule { propId: string; dir: 'asc' | 'desc' }
export interface DbView {
  id: string; name: string; type: DbViewType;
  filters: FilterRule[]; filterMode?: 'and' | 'or';
  sorts: SortRule[];
  groupBy?: string;          // board : propriété select/status
  dateProp?: string;         // calendar / timeline
  endDateProp?: string;      // timeline
  hiddenProps?: string[];
  widths?: Record<string, number>;
}
export interface DatabaseSchema { id: ID; properties: PropertyDef[]; views: DbView[] }
