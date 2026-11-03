// Opérations sur les blocs (poignée ⋮⋮, raccourcis) : supprimer, dupliquer, déplacer, transformer.
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';

export type TurnInto = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'toggle' | 'quote' | 'callout' | 'code';

export const TURN_INTO: { id: TurnInto; label: string; icon: string }[] = [
  { id: 'paragraph', label: 'Texte', icon: 'Aa' },
  { id: 'h1', label: 'Titre 1', icon: 'H1' },
  { id: 'h2', label: 'Titre 2', icon: 'H2' },
  { id: 'h3', label: 'Titre 3', icon: 'H3' },
  { id: 'bullet', label: 'Liste à puces', icon: '•' },
  { id: 'ordered', label: 'Liste numérotée', icon: '1.' },
  { id: 'task', label: 'Liste de tâches', icon: '☑' },
  { id: 'toggle', label: 'Toggle', icon: '▸' },
  { id: 'quote', label: 'Citation', icon: '❝' },
  { id: 'callout', label: 'Callout', icon: '💡' },
  { id: 'code', label: 'Code', icon: '</>' },
];

const LIST_ITEMS = new Set(['listItem', 'taskItem']);

/** Bloc « déplaçable » contenant la position : élément de liste ou bloc de premier niveau. */
export function blockAt($pos: ResolvedPos): { pos: number; node: PMNode } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (LIST_ITEMS.has(n.type.name)) return { pos: $pos.before(d), node: n };
  }
  if ($pos.depth < 1) { const n = $pos.nodeAfter; return n ? { pos: $pos.pos, node: n } : null; }
  return { pos: $pos.before(1), node: $pos.node(1) };
}

export function deleteBlock(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos); if (!node) return false;
  return editor.chain().focus().command(({ tr }) => { tr.delete(pos, pos + node.nodeSize); return true; }).run();
}

export function duplicateBlock(editor: Editor, pos?: number) {
  const { state } = editor;
  const target = pos !== undefined ? { pos, node: state.doc.nodeAt(pos) } : blockAt(state.selection.$from);
  if (!target?.node) return false;
  const end = target.pos + target.node.nodeSize;
  return editor.chain().focus().command(({ tr }) => {
    tr.insert(end, target.node!.copy(target.node!.content));
    const sel = TextSelection.near(tr.doc.resolve(Math.min(end + 1, tr.doc.content.size)));
    tr.setSelection(sel).scrollIntoView();
    return true;
  }).run();
}

/** Déplace le bloc courant vers le haut (-1) ou le bas (+1) parmi ses frères. */
export function moveBlock(editor: Editor, dir: -1 | 1, pos?: number) {
  const { state } = editor;
  const target = pos !== undefined ? { pos, node: state.doc.nodeAt(pos) } : blockAt(state.selection.$from);
  if (!target?.node) return false;
  const $p = state.doc.resolve(target.pos);
  const parent = $p.parent; const index = $p.index();
  const swapIndex = index + dir;
  if (swapIndex < 0 || swapIndex >= parent.childCount) return false;
  const other = parent.child(swapIndex);
  const node = target.node;
  const offsetInBlock = state.selection.from - target.pos;
  return editor.chain().command(({ tr }) => {
    if (dir === -1) {
      const otherPos = target.pos - other.nodeSize;
      tr.replaceWith(otherPos, target.pos + node.nodeSize, [node, other]);
      const newPos = otherPos;
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newPos + Math.max(1, offsetInBlock), tr.doc.content.size))));
    } else {
      const end = target.pos + node.nodeSize + other.nodeSize;
      tr.replaceWith(target.pos, end, [other, node]);
      const newPos = target.pos + other.nodeSize;
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newPos + Math.max(1, offsetInBlock), tr.doc.content.size))));
    }
    tr.scrollIntoView();
    return true;
  }).focus().run();
}

/** Transforme le bloc situé à `pos` (ou le bloc courant) dans un autre type. */
export function turnInto(editor: Editor, kind: TurnInto, pos?: number) {
  const { state } = editor;
  const node = pos !== undefined ? state.doc.nodeAt(pos) : null;
  let chain = editor.chain().focus();
  if (node && pos !== undefined) {
    const from = TextSelection.near(state.doc.resolve(pos + 1), 1).from;
    const to = TextSelection.near(state.doc.resolve(pos + node.nodeSize - 1), -1).to;
    chain = chain.setTextSelection({ from, to: Math.max(from, to) });
  }
  chain = chain.clearNodes();
  switch (kind) {
    case 'paragraph': chain = chain.setParagraph(); break;
    case 'h1': chain = chain.setHeading({ level: 1 }); break;
    case 'h2': chain = chain.setHeading({ level: 2 }); break;
    case 'h3': chain = chain.setHeading({ level: 3 }); break;
    case 'bullet': chain = chain.toggleBulletList(); break;
    case 'ordered': chain = chain.toggleOrderedList(); break;
    case 'task': chain = chain.toggleTaskList(); break;
    case 'toggle': chain = chain.setDetails(); break;
    case 'quote': chain = chain.toggleBlockquote(); break;
    case 'callout': chain = chain.setCallout(); break;
    case 'code': chain = chain.setCodeBlock(); break;
  }
  return chain.run();
}

/** Applique une couleur de texte / de fond à tout le bloc. */
export function colorBlock(editor: Editor, pos: number, color: { text?: string | null; bg?: string | null }) {
  const node = editor.state.doc.nodeAt(pos); if (!node) return false;
  let chain = editor.chain().focus().setTextSelection({ from: pos + 1, to: pos + node.nodeSize - 1 });
  if (color.text !== undefined) chain = color.text ? chain.setColor(color.text) : chain.unsetColor();
  if (color.bg !== undefined) chain = color.bg ? chain.setHighlight({ color: color.bg }) : chain.unsetHighlight();
  return chain.setTextSelection(pos + node.nodeSize - 1).run();
}

/** Nom lisible d'un type de bloc. */
export function blockLabel(node: PMNode | null): string {
  if (!node) return 'Bloc';
  const map: Record<string, string> = {
    paragraph: 'Texte', bulletList: 'Liste à puces', orderedList: 'Liste numérotée', taskList: 'Liste de tâches', listItem: 'Élément de liste', taskItem: 'Tâche',
    blockquote: 'Citation', codeBlock: 'Code', horizontalRule: 'Séparateur', table: 'Tableau', details: 'Toggle', callout: 'Callout', columns: 'Colonnes',
    image: 'Image', video: 'Vidéo', audio: 'Audio', fileBlock: 'Fichier', embed: 'Intégration', youtube: 'YouTube', blockMath: 'Équation', pageBlock: 'Page',
  };
  if (node.type.name === 'heading') return `Titre ${node.attrs.level}`;
  return map[node.type.name] ?? node.type.name;
}

/** Fait défiler jusqu'au bloc n° `index` (premier niveau) et le met en évidence. */
export function revealBlock(editor: Editor, index: number, text?: string) {
  const doc = editor.state.doc;
  let pos = -1; let i = 0;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = text ? norm(text).slice(0, 60) : '';
  doc.forEach((child, offset) => {
    if (pos >= 0) return;
    if (i === index && (!wanted || norm(child.textContent).includes(wanted))) pos = offset;
    i++;
  });
  if (pos < 0 && wanted) doc.forEach((child, offset) => { if (pos < 0 && norm(child.textContent).includes(wanted)) pos = offset; });
  if (pos < 0) return false;
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  editor.chain().setTextSelection(TextSelection.near(doc.resolve(pos + 1)).from).run();
  if (dom && dom.nodeType === 1) {
    dom.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    dom.classList.remove('block-flash');
    void dom.offsetWidth;
    dom.classList.add('block-flash');
    setTimeout(() => dom.classList.remove('block-flash'), 2000);
  }
  return true;
}
