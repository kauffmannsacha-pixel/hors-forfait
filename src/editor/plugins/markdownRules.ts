// Markdown « live » complémentaire (en plus des règles StarterKit) + collage intelligent + raccourcis de blocs.
import { Extension, InputRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { markdownToHTML, looksLikeMarkdown } from '../markdown';
import { toEmbedUrl } from '../nodes/embed';
import { importBrowserFile } from '../media';
import { duplicateBlock, moveBlock } from '../blockOps';
import { toast } from '../../ui/appState';

export const MarkdownShortcuts = Extension.create({
  name: 'markdownShortcuts',
  addInputRules() {
    return [
      // « >> » + espace → toggle (Details)
      new InputRule({ find: /^\s*>>\s$/, handler: ({ range, chain }) => { chain().deleteRange(range).setDetails().run(); } }),
      // « " » + espace → citation (raccourci Notion)
      new InputRule({ find: /^\s*"\s$/, handler: ({ range, chain }) => { chain().deleteRange(range).toggleBlockquote().run(); } }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-ArrowUp': () => moveBlock(this.editor, -1),
      'Mod-Shift-ArrowDown': () => moveBlock(this.editor, 1),
      'Mod-d': () => duplicateBlock(this.editor),
    };
  },
});

export const SmartPaste = Extension.create({
  name: 'smartPaste',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey('smartPaste'),
      props: {
        handlePaste(view, event) {
          const dt = event.clipboardData; if (!dt) return false;
          const $from = view.state.selection.$from;
          if ($from.parent.type.spec.code) return false;
          const hasHtml = dt.types.includes('text/html');
          // Images collées (capture d'écran) → bloc image
          const images = Array.from(dt.files ?? []).filter(f => f.type.startsWith('image/'));
          if (images.length && !hasHtml) {
            event.preventDefault();
            void (async () => {
              for (const f of images) {
                try {
                  const r = await importBrowserFile(f);
                  editor.chain().focus().insertContent({ type: 'image', attrs: { src: r.src, alt: r.name, title: r.name, hash: r.hash ?? null } }).run();
                } catch (e) { toast((e as Error).message, 'error'); }
              }
            })();
            return true;
          }
          if (hasHtml || dt.files?.length) return false;
          const text = dt.getData('text/plain');
          if (!text) return false;
          // Lien seul sur une ligne vide → intégration (YouTube, Vimeo, Figma…)
          const single = text.trim();
          if (/^https?:\/\/\S+$/.test(single) && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
            const info = toEmbedUrl(single);
            if (info && info.provider !== 'web') { editor.chain().focus().setEmbed(single).run(); return true; }
          }
          // Markdown → blocs
          if (looksLikeMarkdown(text)) {
            editor.chain().focus().insertContent(markdownToHTML(text), { parseOptions: { preserveWhitespace: false } }).run();
            return true;
          }
          return false;
        },
      },
    })];
  },
});
