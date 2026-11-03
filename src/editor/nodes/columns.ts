// Colonnes (2 à 3) redimensionnables. La largeur de chaque colonne est un poids flex (attr `width`).
import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      /** Insère un bloc de `count` colonnes vides à la sélection. */
      insertColumns: (count?: number) => ReturnType;
    };
  }
}

const weight = (w: unknown) => { const n = Number(w); return Number.isFinite(n) && n > 0 ? n : 1; };

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  defining: true,
  selectable: false,
  addAttributes() {
    return {
      width: {
        default: 1,
        parseHTML: el => weight(el.getAttribute('data-width')),
        renderHTML: a => ({ 'data-width': a.width, style: `flex: ${weight(a.width)} 1 0%` }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="column"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'column' }), 0]; },
});

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column column column?',
  defining: true,
  isolating: true,
  draggable: true,

  parseHTML() { return [{ tag: 'div[data-type="columns"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'columns' }), 0]; },

  addCommands() {
    return {
      insertColumns: (count = 2) => ({ chain, state }) => {
        const n = Math.max(2, Math.min(3, count));
        const at = state.selection.from;
        return chain().insertContent({
          type: this.name,
          content: Array.from({ length: n }, () => ({ type: 'column', attrs: { width: 1 }, content: [{ type: 'paragraph' }] })),
        }).command(({ tr }) => {
          // place le curseur dans la première colonne
          let target = -1;
          tr.doc.nodesBetween(Math.max(0, at - 2), Math.min(tr.doc.content.size, at + 4), (nd, pos) => {
            if (target < 0 && nd.type.name === 'columns') { target = pos; return false; }
            return target < 0;
          });
          if (target >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(target + 3)));
          return true;
        }).run();
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current: PMNode = node;
      const dom = document.createElement('div');
      dom.className = 'columns-wrap';
      const content = document.createElement('div');
      content.className = 'columns'; content.dataset.type = 'columns';
      const handles = document.createElement('div');
      handles.className = 'col-handles'; handles.contentEditable = 'false';
      dom.append(content, handles);

      const layout = () => {
        const cols = Array.from(content.children) as HTMLElement[];
        while (handles.children.length > Math.max(0, cols.length - 1)) handles.lastChild?.remove();
        while (handles.children.length < cols.length - 1) {
          const h = document.createElement('div');
          h.className = 'col-handle'; h.title = 'Glisser pour redimensionner';
          h.addEventListener('pointerdown', startDrag);
          handles.appendChild(h);
        }
        const base = dom.getBoundingClientRect();
        cols.slice(0, -1).forEach((c, i) => {
          const r = c.getBoundingClientRect();
          const next = cols[i + 1].getBoundingClientRect();
          (handles.children[i] as HTMLElement).style.left = `${(r.right + next.left) / 2 - base.left}px`;
          (handles.children[i] as HTMLElement).dataset.index = String(i);
        });
      };

      function startDrag(e: PointerEvent) {
        if (!editor.isEditable) return;
        e.preventDefault(); e.stopPropagation();
        const h = e.currentTarget as HTMLElement;
        const i = Number(h.dataset.index);
        const cols = Array.from(content.children) as HTMLElement[];
        const a = cols[i]; const b = cols[i + 1]; if (!a || !b) return;
        const wa = a.getBoundingClientRect().width; const wb = b.getBoundingClientRect().width;
        const ga = weight(current.child(i).attrs.width); const gb = weight(current.child(i + 1).attrs.width);
        const total = wa + wb; const gTotal = ga + gb; const startX = e.clientX;
        const min = Math.min(120, total * 0.2);
        let na = ga; let nb = gb;
        h.setPointerCapture(e.pointerId); h.classList.add('dragging'); dom.classList.add('resizing');
        const move = (ev: PointerEvent) => {
          // suivi 1:1 du pointeur, borné (largeur mini par colonne)
          const newA = Math.max(min, Math.min(total - min, wa + (ev.clientX - startX)));
          na = (newA / total) * gTotal; nb = gTotal - na;
          a.style.flex = `${na} 1 0%`; b.style.flex = `${nb} 1 0%`;
          layout();
        };
        const up = () => {
          h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
          h.classList.remove('dragging'); dom.classList.remove('resizing');
          const pos = getPos(); if (typeof pos !== 'number') return;
          editor.chain().command(({ tr }) => {
            const n = tr.doc.nodeAt(pos); if (!n || n.type.name !== 'columns') return false;
            let p = pos + 1;
            for (let k = 0; k < n.childCount; k++) {
              const c = n.child(k);
              if (k === i) tr.setNodeMarkup(p, undefined, { ...c.attrs, width: Math.round(na * 1000) / 1000 });
              if (k === i + 1) tr.setNodeMarkup(p, undefined, { ...c.attrs, width: Math.round(nb * 1000) / 1000 });
              p += c.nodeSize;
            }
            return true;
          }).run();
        };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      }

      const ro = new ResizeObserver(() => layout());
      ro.observe(content);
      requestAnimationFrame(layout);

      return {
        dom, contentDOM: content,
        update: n => { if (n.type !== current.type) return false; current = n; requestAnimationFrame(layout); return true; },
        stopEvent: e => handles.contains(e.target as globalThis.Node),
        ignoreMutation: m => handles.contains(m.target as globalThis.Node) || (m.type === 'attributes' && m.target !== content && (m.target as HTMLElement).parentElement === content && m.attributeName === 'style'),
        destroy: () => ro.disconnect(),
      };
    };
  },
});
