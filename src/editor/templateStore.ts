// État de la galerie de templates (ouverte depuis le menu « / », la palette ou la sidebar).
import type { Editor } from '@tiptap/core';
import { create } from 'zustand';

export interface GalleryState { open: boolean; mode: 'new' | 'insert'; editor?: Editor; parentId?: string | null }
export const useTemplateGallery = create<GalleryState>(() => ({ open: false, mode: 'new' }));

/** mode 'new' = créer une page depuis un template ; 'insert' = insérer dans l'éditeur fourni. */
export const openTemplateGallery = (opts: { mode: 'new' | 'insert'; editor?: Editor; parentId?: string | null }) =>
  useTemplateGallery.setState({ open: true, editor: undefined, parentId: undefined, ...opts });
export const closeTemplateGallery = () => useTemplateGallery.setState({ open: false, editor: undefined });
