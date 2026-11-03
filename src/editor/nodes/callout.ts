// Bloc « callout » : emoji + couleur + contenu riche. NodeView DOM légère (pas de React).
import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core';
import { pickEmoji } from '../ui/overlays';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { emoji?: string; color?: string }) => ReturnType;
      toggleCallout: (attrs?: { emoji?: string; color?: string }) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      emoji: { default: '💡', parseHTML: el => el.getAttribute('data-emoji') || '💡', renderHTML: a => ({ 'data-emoji': a.emoji }) },
      color: { default: 'default', parseHTML: el => el.getAttribute('data-color') || 'default', renderHTML: a => ({ 'data-color': a.color }) },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="callout"]', contentElement: '.callout-content' },
      // Export Notion : <aside>💡 texte</aside>
      {
        tag: 'aside',
        getAttrs: el => {
          const first = (el as HTMLElement).textContent?.trim() ?? '';
          const m = first.match(/^(\p{Extended_Pictographic}️?)/u);
          return { emoji: m ? m[1] : '💡' };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'callout' }),
      ['span', { class: 'callout-emoji', contenteditable: 'false' }, node.attrs.emoji],
      ['div', { class: 'callout-content' }, 0]];
  },

  addCommands() {
    return {
      setCallout: attrs => ({ commands }) => commands.wrapIn(this.name, attrs),
      toggleCallout: attrs => ({ commands }) => commands.toggleWrap(this.name, attrs),
      unsetCallout: () => ({ commands }) => commands.lift(this.name),
    };
  },

  addInputRules() {
    // « >! » + espace en début de ligne → callout
    return [wrappingInputRule({ find: /^\s*>!\s$/, type: this.type })];
  },

  addKeyboardShortcuts() {
    return {
      // Retour arrière au début d'un callout vide → on le retire
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        for (let d = $from.depth; d > 0; d--) {
          const n = $from.node(d);
          if (n.type.name === this.name) {
            const first = $from.index(d) === 0 && $from.depth === d + 1;
            return first && n.textContent === '' && n.childCount === 1 ? editor.commands.lift(this.name) : false;
          }
        }
        return false;
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'callout'; dom.dataset.type = 'callout'; dom.dataset.color = node.attrs.color;
      const emoji = document.createElement('button');
      emoji.type = 'button'; emoji.className = 'callout-emoji'; emoji.contentEditable = 'false';
      emoji.textContent = node.attrs.emoji; emoji.title = 'Changer l’emoji et la couleur';
      const content = document.createElement('div');
      content.className = 'callout-content';
      dom.append(emoji, content);
      emoji.addEventListener('mousedown', e => e.preventDefault());
      emoji.addEventListener('click', async () => {
        if (!editor.isEditable) return;
        const r = await pickEmoji(emoji, { colors: true, color: current.attrs.color });
        if (!r) return;
        const pos = getPos(); if (typeof pos !== 'number') return;
        editor.chain().command(({ tr }) => {
          const n = tr.doc.nodeAt(pos); if (!n || n.type.name !== 'callout') return false;
          tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...(r.emoji ? { emoji: r.emoji } : {}), ...(r.color ? { color: r.color } : {}) });
          return true;
        }).run();
      });
      return {
        dom, contentDOM: content,
        update: n => {
          if (n.type !== current.type) return false;
          current = n;
          if (emoji.textContent !== n.attrs.emoji) emoji.textContent = n.attrs.emoji;
          dom.dataset.color = n.attrs.color;
          return true;
        },
        stopEvent: e => emoji.contains(e.target as globalThis.Node),
        ignoreMutation: m => emoji.contains(m.target as globalThis.Node),
      };
    };
  },
});
