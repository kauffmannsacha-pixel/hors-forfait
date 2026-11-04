// CONTRAT : éditeur de blocs réutilisable (pages, mails, scripts…).
// mode 'full' = toutes les extensions (blocs Notion + registry.editorExtensions + registry.slashItems) ;
// mode 'compact' = mise en forme simple (mail, commentaires).
// Performance : aucun re-render React par frappe (shouldRerenderOnTransaction: false, NodeViews DOM légères),
// onChange optionnellement « debouncé » (changeDebounceMs) et vidé à la perte de focus / au démontage.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { AnyExtension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isTauri } from '../db/store';
import { createExtensions } from './extensions';
import { BlockHandle } from './ui/BlockHandle';
import { FormatBubble } from './ui/FormatBubble';
import { TableBubble } from './ui/TableBubble';
import 'katex/dist/katex.min.css';
import './editor.css';

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
  /** Regroupe les appels à onChange (ms). 0 = à chaque modification. Vidé au blur et au démontage. */
  changeDebounceMs?: number;
  /** Place le curseur à la fin au montage. */
  autofocus?: boolean;
}

async function openLink(href: string) {
  if (isTauri && /^(https?:|mailto:)/i.test(href)) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(href); }
  else window.open(href, '_blank', 'noopener');
}

function BlockEditorImpl({ content, onChange, editable = true, mode = 'full', extraExtensions = [], placeholder, onReady, className, changeDebounceMs = 0, autofocus }: BlockEditorProps) {
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  const debounceRef = useRef(changeDebounceMs); debounceRef.current = changeDebounceMs;
  const timer = useRef<number>(0);
  const dirty = useRef<{ doc: PMNode; editor: Editor } | null>(null);
  // Options figées au montage : le contenu initial n'est lu qu'une fois (remonter via `key` pour recharger).
  const [initial] = useState(() => content as object);
  const extensions = useMemo(() => createExtensions({ mode, placeholder, extra: extraExtensions }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = () => {
    window.clearTimeout(timer.current);
    const d = dirty.current; dirty.current = null;
    if (d) onChangeRef.current?.(d.doc.toJSON(), d.editor);
  };
  const flushRef = useRef(flush); flushRef.current = flush;

  const editorProps = useMemo(() => ({
    attributes: { class: `pm-root pm-${mode}`, spellcheck: 'true', 'aria-label': 'Contenu de la page' },
    handleClick: (_view: unknown, _pos: number, event: MouseEvent) => {
      const a = (event.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null;
      if (a && (event.ctrlKey || event.metaKey || !editable)) { event.preventDefault(); void openLink(a.getAttribute('href') ?? ''); return true; }
      return false;
    },
  }), [mode, editable]);

  const editor = useEditor({
    extensions,
    content: initial,
    editable,
    autofocus: autofocus ? 'end' : false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps,
    onCreate: ({ editor: e }) => onReadyRef.current?.(e),
    onUpdate: ({ editor: e }) => {
      if (!onChangeRef.current) return;
      dirty.current = { doc: e.state.doc, editor: e };
      if (debounceRef.current <= 0) { flushRef.current(); return; }
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flushRef.current(), debounceRef.current);
    },
    onBlur: () => flushRef.current(),
  }, []);

  useEffect(() => { if (editor && editor.isEditable !== editable) editor.setEditable(editable); }, [editor, editable]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current(); };
    const onUnload = () => flushRef.current();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('beforeunload', onUnload); flushRef.current(); };
  }, []);

  return (
    <div className={`block-editor block-editor-${mode} ${className ?? 'prose'}`}>
      <EditorContent editor={editor} />
      {mode === 'full' && editor && editable && <>
        <BlockHandle editor={editor} />
        <FormatBubble editor={editor} />
        <TableBubble editor={editor} />
      </>}
      {mode === 'compact' && editor && editable && <FormatBubble editor={editor} />}
    </div>
  );
}

/** Mémoïsé : les changements de `content` après montage sont ignorés (utiliser `key` pour recharger). */
export const BlockEditor = memo(BlockEditorImpl, (a, b) => a.editable === b.editable && a.mode === b.mode && a.className === b.className && a.onChange === b.onChange && a.onReady === b.onReady);
