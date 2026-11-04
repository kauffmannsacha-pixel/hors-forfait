// Insertion en streaming d'une réponse de Claude dans l'éditeur TipTap, à un emplacement suivi
// malgré les autres modifications. Les étapes intermédiaires restent hors de l'historique ;
// la validation crée UNE seule étape annulable (Ctrl+Z revient au texte d'origine).
import type { Editor } from '@tiptap/core';
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { markdownToEditorHtml } from './markdown';
import { docToMarkdown } from './pageText';

const OWN = 'prismeClaudeInline';

export interface InsertRange { from: number; to: number }

/** Cibles d'une commande « / » : où insérer, et quel texte transformer. */
export interface SlashTargets {
  /** Emplacement d'insertion (remplace le paragraphe vide, sinon juste après le bloc). */
  insert: InsertRange;
  /** Bloc à transformer (bloc courant s'il contient du texte, sinon bloc précédent). */
  target: (InsertRange & { markdown: string }) | null;
}

/** Calcule les cibles autour de la position `pos` (après suppression du texte « /… »). */
export function slashTargets(editor: Editor, pos: number): SlashTargets {
  const { doc } = editor.state;
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  let depth = $pos.depth;
  while (depth > 0 && !$pos.node(depth).isTextblock) depth--;
  if (depth === 0) return { insert: { from: pos, to: pos }, target: null };
  const block = $pos.node(depth);
  const start = $pos.before(depth); const end = $pos.after(depth);
  if (block.textContent.trim()) {
    return { insert: { from: end, to: end }, target: { from: start, to: end, markdown: docToMarkdown(block.toJSON()) } };
  }
  const parent = $pos.node(depth - 1); const index = $pos.index(depth - 1);
  let target: SlashTargets['target'] = null;
  if (index > 0) {
    const prev = parent.child(index - 1);
    if (prev.textContent.trim()) target = { from: start - prev.nodeSize, to: start, markdown: docToMarkdown(prev.toJSON()) };
  }
  return { insert: { from: start, to: end }, target };
}

/** Plage d'une sélection, étendue aux blocs entiers sauf si elle est à l'intérieur d'un seul paragraphe. */
export function selectionRange(editor: Editor): (InsertRange & { inline: boolean; markdown: string; text: string }) | null {
  const { state } = editor;
  const { from, to, $from, $to } = state.selection;
  if (from === to) return null;
  const text = state.doc.textBetween(from, to, '\n\n', ' ');
  if (!text.trim()) return null;
  if ($from.sameParent($to) && $from.parent.isTextblock) {
    const whole = from <= $from.start() && to >= $from.end();
    if (!whole) return { from, to, inline: true, markdown: text, text };
    const f = $from.before(); const t = $from.after();
    return { from: f, to: t, inline: false, markdown: docToMarkdown($from.parent.toJSON()), text };
  }
  const f = $from.depth > 0 ? $from.before(Math.max(1, $from.depth)) : from;
  const t = $to.depth > 0 ? $to.after(Math.max(1, $to.depth)) : to;
  const slice = state.doc.slice(f, t);
  return { from: f, to: t, inline: false, markdown: docToMarkdown({ type: 'doc', content: slice.content.toJSON() }), text };
}

export class StreamInsertion {
  private from: number;
  private to: number;
  private readonly original: Slice;
  private readonly unsubscribe: () => void;
  private disposed = false;
  committed = false;

  constructor(private editor: Editor, range: InsertRange, private inline = false) {
    this.from = range.from; this.to = range.to;
    this.original = editor.state.doc.slice(range.from, range.to);
    const onTransaction = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => {
      if (this.disposed || transaction.getMeta(OWN) || !transaction.docChanged) return;
      this.from = transaction.mapping.map(this.from, 1);
      this.to = Math.max(this.from, transaction.mapping.map(this.to, -1));
    };
    editor.on('transaction', onTransaction);
    this.unsubscribe = () => editor.off('transaction', onTransaction);
  }

  get range(): InsertRange { return { from: this.from, to: this.to }; }
  get alive() { return !this.disposed && !this.editor.isDestroyed; }

  /** Markdown → contenu ProseMirror (en ligne si la cible est un morceau de paragraphe). */
  private toContent(md: string): Fragment {
    const div = document.createElement('div');
    div.innerHTML = markdownToEditorHtml(md);
    const doc: PMNode = PMDOMParser.fromSchema(this.editor.schema).parse(div);
    if (this.inline && doc.childCount === 1 && doc.firstChild?.isTextblock) return doc.firstChild.content;
    return doc.content;
  }

  private replace(content: Fragment | Slice, history: boolean) {
    if (!this.alive) return;
    const { state, view } = this.editor;
    const size = state.doc.content.size;
    const from = Math.min(this.from, size); const to = Math.min(Math.max(this.to, from), size);
    const tr = state.tr;
    if (content instanceof Slice) tr.replace(from, to, content);
    else if (content.size) tr.replaceWith(from, to, content);
    else tr.delete(from, to);
    const nFrom = tr.mapping.map(from, -1); const nTo = tr.mapping.map(to, 1);
    tr.setMeta(OWN, true);
    if (!history) tr.setMeta('addToHistory', false);
    view.dispatch(tr);
    this.from = nFrom; this.to = Math.max(nFrom, nTo);
  }

  /** Remplace le contenu inséré par la version courante (hors historique). */
  update(md: string) { if (md.trim()) this.replace(this.toContent(md), false); }

  /** Version finale : une seule étape d'historique (texte d'origine → résultat). */
  commit(md: string) {
    if (!this.alive) return;
    this.replace(this.original, false);
    this.replace(this.toContent(md), true);
    this.committed = true;
  }

  /** Rétablit le texte d'origine. */
  revert() { this.replace(this.original, this.committed); this.committed = false; }

  /** Insère un nœud (ex. lien vers une base créée) à la place de la plage suivie. */
  insertNode(json: Record<string, unknown>) {
    if (!this.alive) return;
    const node = this.editor.schema.nodeFromJSON(json);
    this.replace(Fragment.from(node), true);
    this.committed = true;
  }

  /** Coordonnées écran de la fin de la plage (pour placer la barre flottante). */
  coords(): { left: number; top: number; bottom: number } | null {
    if (!this.alive) return null;
    try {
      const pos = Math.min(Math.max(this.to - (this.to > this.from ? 1 : 0), 0), this.editor.state.doc.content.size);
      const c = this.editor.view.coordsAtPos(pos);
      const s = this.editor.view.coordsAtPos(Math.min(this.from, this.editor.state.doc.content.size));
      return { left: s.left, top: s.top, bottom: c.bottom };
    } catch { return null; }
  }

  dispose() { if (!this.disposed) { this.disposed = true; this.unsubscribe(); } }
}
