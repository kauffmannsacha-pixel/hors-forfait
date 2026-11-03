// Construction de la liste d'extensions TipTap (mode 'full' pour les pages, 'compact' pour mails/commentaires).
import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import { TableKit } from '@tiptap/extension-table';
import { Mathematics } from '@tiptap/extension-mathematics';
import Typography from '@tiptap/extension-typography';
import Youtube from '@tiptap/extension-youtube';
import { editorExtensions } from '../ui/registry';
import { Callout } from './nodes/callout';
import { Column, Columns } from './nodes/columns';
import { Embed } from './nodes/embed';
import { PrismeImage, Video, Audio, FileBlock } from './nodes/media';
import { PageBlock } from './nodes/pageBlock';
import { PrismeMention } from './nodes/mention';
import { CodeBlock } from './nodes/codeBlock';
import { SlashCommand } from './plugins/slash';
import { MarkdownShortcuts, SmartPaste } from './plugins/markdownRules';
import { mathClickHandler } from './plugins/mathEdit';

export const DEFAULT_PLACEHOLDER = 'Tape / pour les commandes';

function placeholderFor(text: string) {
  return Placeholder.configure({
    includeChildren: true,
    showOnlyCurrent: true,
    placeholder: ({ node, editor, pos }) => {
      if (node.type.name === 'heading') return `Titre ${node.attrs.level}`;
      if (node.type.name === 'detailsSummary') return 'Toggle';
      if (node.type.name === 'codeBlock') return '';
      const $pos = editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size));
      for (let d = $pos.depth; d > 0; d--) {
        const n = $pos.node(d).type.name;
        if (n === 'listItem' || n === 'taskItem') return 'Élément de liste';
        if (n === 'tableCell' || n === 'tableHeader') return '';
        if (n === 'blockquote') return 'Citation';
      }
      return text;
    },
  });
}

const baseKit = (full: boolean) => StarterKit.configure({
  // Undo/redo « illimité » : profondeur très grande, regroupement par pause de frappe.
  undoRedo: { depth: 1_000_000, newGroupDelay: 450 },
  heading: { levels: [1, 2, 3] },
  codeBlock: full ? false : {},
  dropcursor: { color: 'var(--accent)', width: 3 },
  link: {
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    defaultProtocol: 'https',
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
  },
});

const typography = Typography.configure({ openDoubleQuote: false, closeDoubleQuote: false, openSingleQuote: false, closeSingleQuote: false });

/** Extensions de l'éditeur. `extra` est ajouté en dernier. Les extensions des modules (registre) ne sont incluses qu'en mode 'full'. */
export function createExtensions(opts: { mode: 'full' | 'compact'; placeholder?: string; extra?: AnyExtension[] }): AnyExtension[] {
  const full = opts.mode === 'full';
  const list: AnyExtension[] = [
    baseKit(full),
    placeholderFor(opts.placeholder ?? (full ? DEFAULT_PLACEHOLDER : 'Écris ici…')),
    TextStyle, Color,
    Highlight.configure({ multicolor: true }),
    TaskList, TaskItem.configure({ nested: true }),
    typography,
  ];
  if (full) {
    list.push(
      CodeBlock,
      Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }), DetailsSummary, DetailsContent,
      TableKit.configure({ table: { resizable: true, lastColumnResizable: false, cellMinWidth: 80 } }),
      Mathematics.configure({ katexOptions: { throwOnError: false }, inlineOptions: { onClick: mathClickHandler('inline') }, blockOptions: { onClick: mathClickHandler('block') } }),
      Youtube.configure({ nocookie: true, addPasteHandler: false, HTMLAttributes: { class: 'yt-embed' } }),
      Callout, Columns, Column, Embed, PrismeImage, Video, Audio, FileBlock, PageBlock, PrismeMention,
      SlashCommand, MarkdownShortcuts, SmartPaste,
    );
    const names = new Set(list.map(e => e.name));
    for (const e of editorExtensions) {
      if (names.has(e.name)) { console.warn(`[éditeur] extension « ${e.name} » ignorée : nom déjà utilisé.`); continue; }
      names.add(e.name); list.push(e);
    }
  }
  const names = new Set(list.map(e => e.name));
  for (const e of opts.extra ?? []) if (!names.has(e.name)) { names.add(e.name); list.push(e); }
  return list;
}

let conversion: AnyExtension[] | null = null;
let conversionCount = -1;
/** Extensions pour les conversions HTML/Markdown ⇄ JSON (recalculées si un module en ajoute). */
export function conversionExtensions(): AnyExtension[] {
  if (!conversion || conversionCount !== editorExtensions.length) { conversion = createExtensions({ mode: 'full' }); conversionCount = editorExtensions.length; }
  return conversion;
}
