// Contrats partagés par tous les modules. Ne pas casser sans prévenir.
export type ID = string;
export interface Page {
  id: ID; parentId: ID | null; title: string; icon?: string;
  content: unknown; // JSON TipTap
  favorite: boolean; trashed: boolean; kind: 'page' | 'database' | 'script' | 'studio';
  createdAt: number; updatedAt: number; order: number;
}
export interface PageVersion { id: ID; pageId: ID; content: unknown; title: string; at: number }
export interface VaultFile { hash: string; name: string; mime: string; size: number; path: string; linked: boolean; addedAt: number }
export interface Secret { key: string }
