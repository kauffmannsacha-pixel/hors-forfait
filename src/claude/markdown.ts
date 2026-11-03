// Markdown ⇄ HTML / JSON TipTap pour Claude : rendu sûr (marked + DOMPurify) dans le fil,
// conversion en HTML compatible avec l'éditeur (listes de tâches) et en document TipTap.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { generateJSON, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { editorExtensions } from '../ui/registry';

const md = new Marked({ gfm: true, breaks: false, async: false });

/** Markdown → HTML brut (non assaini). */
export function markdownToRawHtml(src: string): string {
  return md.parse(src ?? '', { async: false }) as string;
}

let hooked = false;
function purifier() {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (/^https?:|^mailto:/i.test(href)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      }
    });
  }
  return DOMPurify;
}

const SANITIZE = {
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|prisme:|#)/i,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style'],
};

/** Markdown → HTML assaini pour l'affichage dans le fil Claude. */
export function renderMarkdown(src: string): string {
  return purifier().sanitize(markdownToRawHtml(src), { ...SANITIZE, ADD_ATTR: ['target'] }) as string;
}

/**
 * Markdown → HTML assaini prêt à être inséré dans l'éditeur TipTap :
 * les cases à cocher GFM deviennent des listes de tâches (data-type="taskList").
 */
export function markdownToEditorHtml(src: string): string {
  const clean = DOMPurify.sanitize(markdownToRawHtml(src), { ...SANITIZE, ADD_ATTR: ['data-type', 'data-checked'] }) as string;
  if (!/type="checkbox"/i.test(clean) || typeof document === 'undefined') return clean;
  const root = document.createElement('div');
  root.innerHTML = clean;
  root.querySelectorAll('ul').forEach(ul => {
    const items = Array.from(ul.children).filter(c => c.tagName === 'LI');
    if (!items.length || !items.every(li => li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'))) return;
    ul.setAttribute('data-type', 'taskList');
    for (const li of items) {
      const box = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', box?.hasAttribute('checked') ? 'true' : 'false');
      box?.remove();
      // TipTap attend un paragraphe dans chaque élément de liste.
      if (!li.querySelector(':scope > p')) {
        const p = document.createElement('p');
        while (li.firstChild && !(li.firstChild instanceof HTMLElement && /^(UL|OL)$/.test(li.firstChild.tagName))) p.appendChild(li.firstChild);
        if (p.firstChild && p.firstChild.nodeType === Node.TEXT_NODE) p.firstChild.textContent = (p.firstChild.textContent ?? '').replace(/^\s+/, '');
        li.insertBefore(p, li.firstChild);
      }
    }
  });
  return root.innerHTML;
}

/** Extensions servant à construire un document hors éditeur (même schéma que les pages). */
export function pageExtensions(): AnyExtension[] {
  const names = new Set(editorExtensions.map(e => e.name));
  const exts: AnyExtension[] = [StarterKit as AnyExtension, ...editorExtensions];
  if (!names.has('table') && !names.has('tableKit')) exts.push(TableKit as AnyExtension);
  return exts;
}

/** Markdown → document TipTap (JSON) compatible avec l'éditeur de pages. */
export function markdownToDoc(src: string): { type: 'doc'; content: unknown[] } {
  const text = (src ?? '').trim();
  if (!text) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const json = generateJSON(markdownToEditorHtml(text), pageExtensions()) as { type: 'doc'; content?: unknown[] };
  return { type: 'doc', content: json.content?.length ? json.content : [{ type: 'paragraph' }] };
}

/** Texte brut d'un Markdown (pour l'aperçu / le presse-papiers « texte »). */
export function markdownToPlain(src: string): string {
  if (typeof document === 'undefined') return src;
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(src);
  return (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
