// Édition des équations au clic (inline et bloc) avec aperçu KaTeX en direct.
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { promptText } from '../ui/overlays';

let lastTarget: Element | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => { lastTarget = e.target instanceof Element ? e.target : null; }, true);
}

/** Éditeur TipTap contenant un élément (TipTap expose l'instance sur la racine .ProseMirror). */
export function editorFromElement(el: Element | null): Editor | null {
  const root = el?.closest('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  return root?.editor ?? null;
}

export function mathClickHandler(kind: 'inline' | 'block') {
  return (node: PMNode, pos: number) => {
    const target = lastTarget?.closest('.tiptap-mathematics-render') ?? lastTarget;
    const editor = editorFromElement(target);
    if (!editor || !editor.isEditable || !target) return;
    void promptText(target, {
      title: kind === 'block' ? 'Modifier l’équation' : 'Modifier l’équation en ligne',
      value: String(node.attrs.latex ?? ''),
      multiline: kind === 'block',
      preview: kind === 'block' ? 'math-block' : 'math-inline',
      confirmLabel: 'Enregistrer',
    }).then(latex => {
      if (latex === null) return;
      const chain = editor.chain().focus();
      if (!latex.trim()) { chain.command(({ tr }) => { tr.delete(pos, pos + node.nodeSize); return true; }).run(); return; }
      if (kind === 'block') chain.updateBlockMath({ latex, pos }).run();
      else chain.updateInlineMath({ latex, pos }).run();
    });
  };
}
