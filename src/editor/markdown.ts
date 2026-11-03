// Conversion Markdown ⇄ TipTap.
//  • docToMarkdown : JSON TipTap → Markdown (GFM), fonction pure.
//  • markdownToHTML : Markdown → HTML compatible avec le schéma de l'éditeur (marked + extensions maths/surlignage/tâches).
// (HTML → JSON via le schéma : voir convert.ts)
import { Marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import type { JSONContent } from '@tiptap/core';
import { formatMentionDate, formatReminder, fromISODate } from './dates';
import { nodeText } from './text';

// ─────────────────────────────── Markdown → HTML ───────────────────────────────
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mathBlock: TokenizerAndRendererExtension = {
  name: 'blockMath', level: 'block',
  start: src => { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer: t => `<div data-type="block-math" data-latex="${escAttr(String(t.text))}"></div>\n`,
};
const mathInline: TokenizerAndRendererExtension = {
  name: 'inlineMath', level: 'inline',
  start: src => { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
    return undefined;
  },
  renderer: t => `<span data-type="inline-math" data-latex="${escAttr(String(t.text))}"></span>`,
};
const highlightMark: TokenizerAndRendererExtension = {
  name: 'highlightMark', level: 'inline',
  start: src => { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^==(?!\s)([^=\n]+?)(?<!\s)==/.exec(src);
    if (m) return { type: 'highlightMark', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    return undefined;
  },
  renderer(t) { return `<mark>${this.parser.parseInline((t as Tokens.Generic).tokens ?? [])}</mark>`; },
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [mathBlock, mathInline, highlightMark],
  renderer: {
    list(token: Tokens.List) {
      if (!token.items.length || !token.items.every(i => i.task)) return false;
      const items = token.items.map(it => `<li data-type="taskItem" data-checked="${it.checked ? 'true' : 'false'}">${this.parser.parse(it.tokens.filter(t => t.type !== 'checkbox'))}</li>`);
      return `<ul data-type="taskList">${items.join('')}</ul>\n`;
    },
  },
});

/** Markdown (GFM) → HTML assaini, prêt pour le schéma de l'éditeur. */
export function markdownToHTML(src: string): string {
  const html = marked.parse(src.replace(/\r\n?/g, '\n'), { async: false }) as string;
  return typeof window !== 'undefined' ? DOMPurify.sanitize(html, { ADD_ATTR: ['data-type', 'data-latex', 'data-checked', 'data-emoji', 'data-color', 'data-width', 'data-kind', 'data-id', 'data-label', 'data-date'] }) : html;
}

const MD_HINTS = [/^#{1,6}\s+\S/m, /^\s*[-*+]\s+\S/m, /^\s*\d+[.)]\s+\S/m, /^\s*>\s?\S/m, /^```/m, /\*\*[^*\n]+\*\*/, /\[[^\]\n]+\]\([^)\s]+\)/, /^\|.+\|\s*$/m, /^\s*(?:-{3,}|\*{3,})\s*$/m, /`[^`\n]+`/, /^\$\$/m];
/** Heuristique : le texte collé est-il du Markdown ? */
export function looksLikeMarkdown(text: string): boolean {
  const hits = MD_HINTS.filter(r => r.test(text)).length;
  return hits >= 2 || (hits === 1 && text.includes('\n'));
}

// ─────────────────────────────── TipTap → Markdown ───────────────────────────────
export interface MdOptions {
  /** Titre courant d'une page mentionnée (sinon le libellé enregistré). */
  pageTitle?: (id: string) => string | undefined;
}

type Mark = { type: string; attrs?: Record<string, unknown> };
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'highlight', 'textStyle', 'code'];
const markKey = (m: Mark) => m.type + JSON.stringify(m.attrs ?? {});

function openMark(m: Mark): string {
  switch (m.type) {
    case 'bold': return '**';
    case 'italic': return '*';
    case 'strike': return '~~';
    case 'code': return '`';
    case 'underline': return '<u>';
    case 'link': return '[';
    case 'highlight': return m.attrs?.color ? `<mark style="background-color: ${escAttr(String(m.attrs.color))}">` : '==';
    case 'textStyle': return m.attrs?.color ? `<span style="color: ${escAttr(String(m.attrs.color))}">` : '';
    default: return '';
  }
}
function closeMark(m: Mark): string {
  switch (m.type) {
    case 'bold': return '**';
    case 'italic': return '*';
    case 'strike': return '~~';
    case 'code': return '`';
    case 'underline': return '</u>';
    case 'link': { const href = String(m.attrs?.href ?? '').replace(/[()\s]/g, c => encodeURIComponent(c)); const t = m.attrs?.title ? ` "${String(m.attrs.title).replace(/"/g, '\\"')}"` : ''; return `](${href}${t})`; }
    case 'highlight': return m.attrs?.color ? '</mark>' : '==';
    case 'textStyle': return m.attrs?.color ? '</span>' : '';
    default: return '';
  }
}

const INLINE_MATH_LIKE = /\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/;
function escapeText(t: string, inTable: boolean): string {
  let s = t.replace(/\\/g, '\\\\').replace(/([*_`[\]<>~])/g, '\\$1');
  if (INLINE_MATH_LIKE.test(t)) s = s.replace(/\$/g, '\\$');
  if (/==/.test(t)) s = s.replace(/==/g, '=\\=');
  if (inTable) s = s.replace(/\|/g, '\\|');
  return s;
}
/** Échappe ce qui transformerait le début d'un paragraphe en autre bloc (#, >, -, 1.). */
const escapeLineStart = (s: string) => s.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, (_, sp, c) => `${sp}\\${c}`);

function codeSpan(text: string): string {
  const ticks = (text.match(/`+/g) ?? []).reduce((m, x) => Math.max(m, x.length), 0);
  const fence = '`'.repeat(ticks + 1);
  return ticks ? `${fence} ${text} ${fence}` : `\`${text}\``;
}

function inlineMd(nodes: JSONContent[] | undefined, opts: MdOptions, inTable = false): string {
  if (!nodes?.length) return '';
  let out = '';
  let active: Mark[] = [];
  const closeTo = (keep: number) => {
    const trailing = out.match(/\s+$/)?.[0] ?? '';
    if (trailing && active.length > keep) out = out.slice(0, -trailing.length);
    for (let i = active.length - 1; i >= keep; i--) out += closeMark(active[i]);
    active = active.slice(0, keep);
    if (trailing && !out.endsWith(trailing)) out += trailing;
  };
  for (const n of nodes) {
    const marks = ((n.marks ?? []) as Mark[]).filter(m => MARK_ORDER.includes(m.type)).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    const isCode = marks.some(m => m.type === 'code');
    // marques à garder = préfixe commun
    let keep = 0;
    while (keep < active.length && keep < marks.length && markKey(active[keep]) === markKey(marks[keep])) keep++;
    if (active.length > keep) closeTo(keep);
    let text: string;
    if (n.type === 'text') text = isCode ? (n.text ?? '') : escapeText(n.text ?? '', inTable);
    else if (n.type === 'hardBreak') text = inTable ? '<br>' : '\\\n';
    else if (n.type === 'mention') text = escapeText(mentionMd(n.attrs ?? {}, opts), inTable);
    else if (n.type === 'inlineMath') text = `$${String(n.attrs?.latex ?? '')}$`;
    else if (n.type === 'image') text = `![${escapeText(String(n.attrs?.alt ?? ''), inTable)}](${String(n.attrs?.src ?? '')})`;
    else if (n.type === 'filePin') text = `📎 ${escapeText(String(n.attrs?.name ?? 'fichier'), inTable)}`;
    else text = escapeText(nodeText(n), inTable);
    // ouvrir les nouvelles marques (les espaces de tête restent à l'extérieur)
    if (marks.length > keep) {
      const lead = isCode ? '' : text.match(/^\s+/)?.[0] ?? '';
      if (lead) { out += lead; text = text.slice(lead.length); }
      for (let i = keep; i < marks.length; i++) out += openMark(marks[i]);
      active = marks.slice();
    }
    if (isCode && n.type === 'text') {
      // un segment de code = un code span complet (contenu brut)
      const codeIdx = active.findIndex(m => m.type === 'code');
      out = out.slice(0, out.length - 1); // retire le ` ouvrant
      out += codeSpan(text);
      active = active.slice(0, codeIdx);
      continue;
    }
    out += text;
  }
  closeTo(0);
  return out;
}

function mentionMd(a: Record<string, unknown>, opts: MdOptions): string {
  if (a.kind === 'date' && typeof a.id === 'string') return '@' + formatMentionDate(fromISODate(a.id));
  if (a.kind === 'reminder' && a.date) return '⏰ ' + formatReminder(new Date(String(a.date)).getTime());
  const live = typeof a.id === 'string' ? opts.pageTitle?.(a.id) : undefined;
  return '@' + (live ?? String(a.label ?? a.id ?? ''));
}

const indentLines = (s: string, pad: string) => s.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n');

function listItemMd(item: JSONContent, marker: string, opts: MdOptions): string {
  const pad = ' '.repeat(marker.length);
  const kids = item.content ?? [];
  const [first, ...rest] = kids;
  let head = first?.type === 'paragraph' ? escapeLineStart(inlineMd(first.content, opts)) : first ? blockMd(first, opts) : '';
  head = indentLines(head, pad);
  const tail = (first?.type === 'paragraph' ? rest : kids.slice(1)).map(k => pad + indentLines(blockMd(k, opts), pad)).join('\n');
  return marker + head + (tail ? '\n' + tail : '');
}

function tableMd(n: JSONContent, opts: MdOptions): string {
  const rows = (n.content ?? []).map(r => (r.content ?? []).map(c => (c.content ?? []).map(p => inlineMd(p.content, opts, true)).join('<br>').trim() || ' '));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => [...r, ...Array(cols - r.length).fill(' ')]);
  const line = (r: string[]) => `| ${r.join(' | ')} |`;
  return [line(norm[0]), line(Array(cols).fill('---')), ...norm.slice(1).map(line)].join('\n');
}

function blocksMd(nodes: JSONContent[] | undefined, opts: MdOptions): string {
  return (nodes ?? []).map(n => blockMd(n, opts)).filter(s => s !== '').join('\n\n');
}

function blockMd(n: JSONContent, opts: MdOptions): string {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'paragraph': return escapeLineStart(inlineMd(n.content, opts));
    case 'heading': return '#'.repeat(Math.min(6, Math.max(1, Number(a.level) || 1))) + ' ' + inlineMd(n.content, opts);
    case 'blockquote': return blocksMd(n.content, opts).split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
    case 'bulletList': return (n.content ?? []).map(it => listItemMd(it, '- ', opts)).join('\n');
    case 'orderedList': { const start = Number(a.start) || 1; return (n.content ?? []).map((it, i) => listItemMd(it, `${start + i}. `, opts)).join('\n'); }
    case 'taskList': return (n.content ?? []).map(it => listItemMd(it, `- [${it.attrs?.checked ? 'x' : ' '}] `, opts)).join('\n');
    case 'codeBlock': {
      const text = nodeText(n);
      const fence = text.includes('```') ? '~~~~' : '```';
      return `${fence}${a.language ?? ''}\n${text}\n${fence}`;
    }
    case 'horizontalRule': return '---';
    case 'image': return `![${escapeText(String(a.alt ?? ''), false)}](${String(a.src ?? '')}${a.title ? ` "${String(a.title).replace(/"/g, '\\"')}"` : ''})`;
    case 'table': return tableMd(n, opts);
    case 'details': {
      const summary = n.content?.find(c => c.type === 'detailsSummary');
      const body = n.content?.find(c => c.type === 'detailsContent');
      const s = escAttr(nodeText(summary));
      return `<details${a.open ? ' open' : ''}>\n<summary>${s}</summary>\n\n${blocksMd(body?.content, opts)}\n\n</details>`;
    }
    case 'callout':
      return `<aside data-emoji="${escAttr(String(a.emoji ?? '💡'))}" data-color="${escAttr(String(a.color ?? 'default'))}">\n\n${blocksMd(n.content, opts)}\n\n</aside>`;
    case 'columns':
      return `<div data-type="columns">\n\n${(n.content ?? []).map(c => `<div data-type="column" data-width="${Number(c.attrs?.width) || 1}">\n\n${blocksMd(c.content, opts)}\n\n</div>`).join('\n\n')}\n\n</div>`;
    case 'blockMath': return `$$\n${String(a.latex ?? '')}\n$$`;
    case 'embed': return `[${escapeText(labelForUrl(String(a.url || a.src)), false)}](${String(a.url || a.src)})`;
    case 'youtube': return `[YouTube](${String(a.src ?? '')})`;
    case 'video': case 'audio': case 'fileBlock': {
      const src = String(a.src ?? '');
      const name = escapeText(String(a.name || 'fichier'), false);
      const icon = n.type === 'video' ? '🎬' : n.type === 'audio' ? '🎵' : '📎';
      return src && !src.startsWith('data:') ? `[${icon} ${name}](${src.replace(/\s/g, '%20')})` : `${icon} ${name}`;
    }
    case 'pageBlock': return `📄 **${escapeText((typeof a.pageId === 'string' ? opts.pageTitle?.(a.pageId) : undefined) ?? String(a.title || 'Page'), false)}**`;
    default: {
      if (n.content?.some(c => c.type === 'text')) return inlineMd(n.content, opts);
      if (n.content) return blocksMd(n.content, opts);
      return escapeText(nodeText(n), false);
    }
  }
}

function labelForUrl(u: string): string {
  try { const h = new URL(u).hostname.replace(/^www\./, ''); return h.includes('youtu') ? '▶ YouTube' : h; } catch { return u; }
}

/** Document TipTap → Markdown (GFM). */
export function docToMarkdown(doc: unknown, opts: MdOptions = {}): string {
  const d = doc as JSONContent | null;
  if (!d) return '';
  const md = d.type === 'doc' ? blocksMd(d.content, opts) : blockMd(d, opts);
  return md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
