// Petit constructeur de documents TipTap (templates, page de bienvenue). Fonctions pures.
import type { JSONContent } from '@tiptap/core';
import { toISODate, formatMentionDate } from './dates';

type Inline = string | JSONContent[];

/** Texte avec mise en forme légère : **gras**, *italique*, `code`, ~~barré~~, ==surligné==, [lien](url). */
export function inline(s: string): JSONContent[] {
  const out: JSONContent[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|==(.+?)==|\[(.+?)\]\((.+?)\)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    if (m[1]) out.push({ type: 'text', text: m[1], marks: [{ type: 'bold' }] });
    else if (m[2]) out.push({ type: 'text', text: m[2], marks: [{ type: 'italic' }] });
    else if (m[3]) out.push({ type: 'text', text: m[3], marks: [{ type: 'code' }] });
    else if (m[4]) out.push({ type: 'text', text: m[4], marks: [{ type: 'strike' }] });
    else if (m[5]) out.push({ type: 'text', text: m[5], marks: [{ type: 'highlight' }] });
    else if (m[6]) out.push({ type: 'text', text: m[6], marks: [{ type: 'link', attrs: { href: m[7] } }] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}
const content = (x: Inline) => (typeof x === 'string' ? (x ? inline(x) : undefined) : x);

export const p = (x: Inline = ''): JSONContent => ({ type: 'paragraph', ...(content(x) ? { content: content(x) } : {}) });
export const h = (level: 1 | 2 | 3, x: Inline): JSONContent => ({ type: 'heading', attrs: { level }, content: content(x) });
const item = (x: Inline | JSONContent[], extra: JSONContent[] = []): JSONContent => ({ type: 'listItem', content: [p(x as Inline), ...extra] });
export const ul = (...items: Inline[]): JSONContent => ({ type: 'bulletList', content: items.map(i => item(i)) });
export const ol = (...items: Inline[]): JSONContent => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map(i => item(i)) });
export const todo = (...items: (string | [boolean, string])[]): JSONContent => ({
  type: 'taskList',
  content: items.map(i => { const [checked, text] = typeof i === 'string' ? [false, i] : i; return { type: 'taskItem', attrs: { checked }, content: [p(text)] }; }),
});
export const quote = (...blocks: (string | JSONContent)[]): JSONContent => ({ type: 'blockquote', content: blocks.map(b => (typeof b === 'string' ? p(b) : b)) });
export const callout = (emoji: string, color: string, ...blocks: (string | JSONContent)[]): JSONContent =>
  ({ type: 'callout', attrs: { emoji, color }, content: blocks.length ? blocks.map(b => (typeof b === 'string' ? p(b) : b)) : [p()] });
export const toggle = (summary: string, ...blocks: (string | JSONContent)[]): JSONContent => ({
  type: 'details', attrs: { open: false },
  content: [{ type: 'detailsSummary', content: inline(summary) }, { type: 'detailsContent', content: blocks.length ? blocks.map(b => (typeof b === 'string' ? p(b) : b)) : [p()] }],
});
export const code = (language: string, text: string): JSONContent => ({ type: 'codeBlock', attrs: { language }, content: text ? [{ type: 'text', text }] : undefined });
export const hr = (): JSONContent => ({ type: 'horizontalRule' });
export const math = (latex: string): JSONContent => ({ type: 'blockMath', attrs: { latex } });
export const table = (rows: string[][], header = true): JSONContent => ({
  type: 'table',
  content: rows.map((r, i) => ({ type: 'tableRow', content: r.map(c => ({ type: header && i === 0 ? 'tableHeader' : 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p(c)] })) })),
});
export const cols = (...columns: (string | JSONContent)[][]): JSONContent => ({
  type: 'columns',
  content: columns.map(c => ({ type: 'column', attrs: { width: 1 }, content: c.length ? c.map(b => (typeof b === 'string' ? p(b) : b)) : [p()] })),
});
export const dateMention = (d: Date): JSONContent => ({ type: 'mention', attrs: { id: toISODate(d), label: formatMentionDate(d), kind: 'date' } });
export const txt = (text: string, marks: string[] = []): JSONContent => ({ type: 'text', text, ...(marks.length ? { marks: marks.map(type => ({ type })) } : {}) });
export const doc = (...blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks.length ? blocks : [p()] });

/** Copie profonde (pour réutiliser un contenu de template sans partage de références). */
export const cloneDoc = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
