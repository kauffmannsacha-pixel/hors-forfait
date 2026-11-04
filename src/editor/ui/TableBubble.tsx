// Barre d'outils des tableaux (lignes, colonnes, en-tête, fusion), ancrée au-dessus du tableau courant.
import { useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';

function tableElement(editor: Editor): HTMLElement | null {
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
    return el?.closest('table') ?? null;
  } catch { return null; }
}

export function TableBubble({ editor }: { editor: Editor }) {
  const shouldShow = useCallback(({ editor: e }: { editor: Editor }) => e.isEditable && e.isActive('table'), []);
  const ref = useCallback(() => {
    const t = tableElement(editor);
    return t ? { getBoundingClientRect: () => t.getBoundingClientRect() } : null;
  }, [editor]);
  const b = (label: string, title: string, run: () => boolean, danger = false) => (
    <button type="button" className={`tb-btn${danger ? ' danger' : ''}`} title={title} onMouseDown={e => e.preventDefault()} onClick={() => run()}>{label}</button>
  );
  const c = () => editor.chain().focus();
  return (
    <BubbleMenu editor={editor} pluginKey="tableBubble" shouldShow={shouldShow} getReferencedVirtualElement={ref} className="table-bubble glass"
      options={{ placement: 'top-start', offset: 6, flip: true, shift: { padding: 8 } }}>
      {b('+ Ligne ↑', 'Insérer une ligne au-dessus', () => c().addRowBefore().run())}
      {b('+ Ligne ↓', 'Insérer une ligne en dessous', () => c().addRowAfter().run())}
      {b('+ Col ←', 'Insérer une colonne à gauche', () => c().addColumnBefore().run())}
      {b('+ Col →', 'Insérer une colonne à droite', () => c().addColumnAfter().run())}
      <span className="fb-sep" />
      {b('En-tête', 'Activer / désactiver la ligne d’en-tête', () => c().toggleHeaderRow().run())}
      {b('Fusionner', 'Fusionner ou scinder les cellules', () => c().mergeOrSplit().run())}
      <span className="fb-sep" />
      {b('− Ligne', 'Supprimer la ligne', () => c().deleteRow().run(), true)}
      {b('− Col', 'Supprimer la colonne', () => c().deleteColumn().run(), true)}
      {b('Supprimer', 'Supprimer le tableau', () => c().deleteTable().run(), true)}
    </BubbleMenu>
  );
}
