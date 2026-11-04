// Poignée ⋮⋮ (glisser pour déplacer un bloc, clic pour le menu) + bouton « + » (ajouter un bloc en dessous).
import { useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import DragHandle from '@tiptap/extension-drag-handle-react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { openMenu, type MenuItem } from '../../ui/Menu';
import { IconCopy, IconGrip, IconPalette, IconPlus, IconTrash, IconRestore, IconArrowRight } from '../../ui/icons';
import { COLORS } from '../colors';
import { TURN_INTO, blockLabel, colorBlock, deleteBlock, duplicateBlock, moveBlock, turnInto } from '../blockOps';

// Constantes de module : DragHandle ré-enregistre son plugin si ces objets changent.
const POSITION = { placement: 'left-start' as const, strategy: 'absolute' as const };
const TEXTUAL = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'details', 'codeBlock']);

export function BlockHandle({ editor }: { editor: Editor }) {
  const cur = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const onNodeChange = useCallback(({ node, pos }: { node: PMNode | null; pos: number }) => { cur.current = { node, pos }; }, []);

  const openBlockMenu = (el: HTMLElement) => {
    const { node, pos } = cur.current;
    if (!node || pos < 0) return;
    editor.commands.lockDragHandle();
    const textual = TEXTUAL.has(node.type.name);
    const items: MenuItem[] = [
      { heading: true, label: blockLabel(node) },
      { label: 'Supprimer', icon: <IconTrash />, shortcut: 'Suppr', danger: true, onSelect: () => { deleteBlock(editor, pos); } },
      { label: 'Dupliquer', icon: <IconCopy />, shortcut: 'Ctrl+D', onSelect: () => { duplicateBlock(editor, pos); } },
      { label: 'Transformer en', icon: <IconRestore />, disabled: !textual, submenu: TURN_INTO.map(t => ({ label: t.label, icon: <span className="glyph">{t.icon}</span>, onSelect: () => { turnInto(editor, t.id, pos); } })) },
      {
        label: 'Couleur', icon: <IconPalette />, disabled: !textual || node.type.name === 'codeBlock', submenu: [
          { heading: true, label: 'Texte' },
          ...COLORS.map(c => ({ label: c.label, icon: <span className="menu-swatch" style={{ color: c.text ?? 'var(--fg)' }}>A</span>, onSelect: () => { colorBlock(editor, pos, { text: c.text }); } })),
          { separator: true }, { heading: true, label: 'Fond' },
          ...COLORS.map(c => ({ label: c.id === 'default' ? 'Aucun' : c.label, icon: <span className="menu-swatch bg" style={{ background: c.bg ?? 'transparent' }}>A</span>, onSelect: () => { colorBlock(editor, pos, { bg: c.bg }); } })),
        ],
      },
      { separator: true },
      { label: 'Monter', icon: <IconArrowRight style={{ transform: 'rotate(-90deg)' }} />, shortcut: 'Ctrl+Maj+↑', onSelect: () => { moveBlock(editor, -1, pos); } },
      { label: 'Descendre', icon: <IconArrowRight style={{ transform: 'rotate(90deg)' }} />, shortcut: 'Ctrl+Maj+↓', onSelect: () => { moveBlock(editor, 1, pos); } },
    ];
    openMenu(el, items, { placement: 'left-start', minWidth: 230, onClose: () => { if (!editor.isDestroyed) editor.commands.unlockDragHandle(); } });
  };

  const addBelow = () => {
    const { node, pos } = cur.current;
    if (!node || pos < 0) return;
    const end = pos + node.nodeSize;
    editor.chain().focus().insertContentAt(end, { type: 'paragraph', content: [{ type: 'text', text: '/' }] }).setTextSelection(end + 2).run();
  };

  return (
    <DragHandle editor={editor} onNodeChange={onNodeChange} computePositionConfig={POSITION} className="block-handle">
      <div className="bh-inner">
        <button type="button" className="bh-btn" title="Ajouter un bloc en dessous" aria-label="Ajouter un bloc" onClick={addBelow}><IconPlus size={15} /></button>
        <button type="button" className="bh-btn bh-grip" title="Glisser pour déplacer · Cliquer pour ouvrir le menu" aria-label="Menu du bloc" onClick={e => openBlockMenu(e.currentTarget)}><IconGrip size={15} /></button>
      </div>
    </DragHandle>
  );
}
