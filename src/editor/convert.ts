// Conversions qui dépendent du schéma de l'éditeur : HTML/Markdown → JSON TipTap, JSON → HTML.
import { generateHTML, generateJSON, type JSONContent, type Editor } from '@tiptap/core';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { conversionExtensions } from './extensions';
import { markdownToHTML } from './markdown';

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** HTML (assaini) → document TipTap. */
export function htmlToDoc(html: string): JSONContent {
  const clean = DOMPurify.sanitize(html, { ADD_TAGS: ['iframe'], ADD_ATTR: ['data-type', 'data-latex', 'data-checked', 'data-emoji', 'data-color', 'data-width', 'data-kind', 'data-id', 'data-label', 'data-date', 'data-src', 'data-url', 'data-provider', 'data-height', 'data-hash', 'data-name', 'data-mime', 'data-size', 'data-page-id', 'data-title'] });
  const doc = generateJSON(clean, conversionExtensions()) as JSONContent;
  return doc.content?.length ? doc : EMPTY_DOC;
}

/** Markdown → document TipTap. */
export const markdownToDoc = (md: string): JSONContent => htmlToDoc(markdownToHTML(md));

/** Remplace les équations (vides en HTML statique) par leur rendu KaTeX. */
export function renderMathInHTML(html: string): string {
  if (!html.includes('-math')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll<HTMLElement>('[data-type="inline-math"], [data-type="block-math"]').forEach(el => {
    const latex = el.getAttribute('data-latex') ?? '';
    try { el.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode: el.getAttribute('data-type') === 'block-math' }); }
    catch { el.textContent = latex; }
  });
  return tpl.innerHTML;
}

/** Document TipTap → HTML statique (équations rendues). */
export function docToHTML(doc: unknown): string {
  const d = (doc as JSONContent | null) ?? EMPTY_DOC;
  return renderMathInHTML(generateHTML(d, conversionExtensions()));
}

/** Insère du Markdown à la position courante d'un éditeur (utile pour Claude). */
export function insertMarkdown(editor: Editor, md: string, at?: number | { from: number; to: number }) {
  const html = markdownToHTML(md);
  return at === undefined ? editor.chain().focus().insertContent(html).run() : editor.chain().focus().insertContentAt(at, html).run();
}
