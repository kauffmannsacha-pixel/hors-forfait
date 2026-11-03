// CONTRAT : éditeur de blocs réutilisable (pages, mails, scripts…). Implémentation enrichie par le module editor.
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { AnyExtension } from '@tiptap/core';
import { editorExtensions } from '../ui/registry';

export interface BlockEditorProps {
  content: unknown;                       // JSON TipTap
  onChange?: (json: unknown, editor: Editor) => void;
  editable?: boolean;
  /** 'full' = toutes les extensions enregistrées (pages) ; 'compact' = mise en forme simple (mail, commentaires) */
  mode?: 'full' | 'compact';
  extraExtensions?: AnyExtension[];
  placeholder?: string;
  onReady?: (editor: Editor) => void;
  className?: string;
}
export function BlockEditor({ content, onChange, editable = true, mode = 'full', extraExtensions = [], onReady, className }: BlockEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit, ...(mode === 'full' ? editorExtensions : []), ...extraExtensions],
    content: content as object, editable,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON(), editor),
    onCreate: ({ editor }) => onReady?.(editor),
  });
  return <EditorContent editor={editor} className={className ?? 'prose'} />;
}
