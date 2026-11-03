// CONTRAT : éditeur actif (pour insérer depuis l'extérieur : drop de fichiers, Claude…).
import type { Editor } from '@tiptap/core';
let active: { editor: Editor; pageId: string | null } | null = null;
export const setActiveEditor = (editor: Editor | null, pageId: string | null = null) => { active = editor ? { editor, pageId } : null; };
export const getActiveEditor = () => active;
