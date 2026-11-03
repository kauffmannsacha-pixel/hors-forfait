// Conversion page (JSON TipTap) → Markdown (standard ou « Discord ») et texte brut. Logique pure, testée.
export type MdFlavor = 'standard' | 'discord';
export interface MdOptions {
  flavor?: MdFlavor;
  /** 'bold' : titres rendus en gras (embeds Discord, où les titres Markdown ne sont pas garantis). */
  headings?: 'markdown' | 'bold';
}
interface Mark { type: string; attrs?: Record<string, unknown> }
export interface JNode { type?: string; attrs?: Record<string, unknown>; content?: JNode[]; text?: string; marks?: Mark[] }
type O = Required<MdOptions>;

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const str = (v: unknown) => (v == null ? '' : String(v));

/** Échappe la syntaxe Markdown dans un texte brut. */
export function escapeMarkdown(text: string, flavor: MdFlavor): string {
  const re = flavor === 'discord' ? /([\\*_~`|])/g : /([\\*_`[\]])/g;
  return text.replace(re, '\\$1');
}

/** Échappe un début de ligne qui serait interprété comme un bloc (titre, citation, liste). */
const escapeLineStart = (s: string) => s.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+\.\s)/gm, (_m, sp: string, tok: string) => `${sp}\\${tok}`);

function wrapKeepSpaces(t: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
  if (!m || !m[2]) return t;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function textWithMarks(n: JNode, o: O): string {
  const marks = n.marks ?? [];
  const has = (t: string) => marks.some(m => m.type === t);
  const raw = n.text ?? '';
  if (has('code')) {
    const fence = raw.includes('`') ? '``' : '`';
    let t = `${fence}${raw.includes('`') ? ` ${raw} ` : raw}${fence}`;
    const link = marks.find(m => m.type === 'link');
    if (link) t = `[${t}](${str(link.attrs?.href)})`;
    return t;
  }
  let t = escapeMarkdown(raw, o.flavor);
  if (has('bold')) t = wrapKeepSpaces(t, '**');
  if (has('italic')) t = wrapKeepSpaces(t, '*');
  if (has('strike')) t = wrapKeepSpaces(t, '~~');
  if (has('underline') && o.flavor === 'discord') t = wrapKeepSpaces(t, '__');
  if (has('highlight') && o.flavor === 'standard') t = wrapKeepSpaces(t, '==');
  const link = marks.find(m => m.type === 'link');
  const href = str(link?.attrs?.href);
  if (link && href) t = /^https?:\/\//i.test(href) || o.flavor === 'standard' ? `[${t.trim() || href}](${href})` : t;
  return t;
}

function inline(nodes: JNode[] | undefined, o: O): string {
  let out = '';
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'text': out += textWithMarks(n, o); break;
      case 'hardBreak': out += o.flavor === 'discord' ? '\n' : '  \n'; break;
      case 'mention': out += `@${str(n.attrs?.label ?? n.attrs?.title ?? n.attrs?.id)}`; break;
      case 'filePin': out += `📎 ${str(n.attrs?.name) || 'fichier'}`; break;
      case 'inlineMath': case 'mathInline': out += o.flavor === 'discord' ? `\`${str(n.attrs?.latex)}\`` : `$${str(n.attrs?.latex)}$`; break;
      case 'emoji': out += str(n.attrs?.emoji ?? n.attrs?.name); break;
      case 'image': out += imageMd(n, o); break;
      default: out += n.text ? escapeMarkdown(n.text, o.flavor) : inline(n.content, o);
    }
  }
  return out;
}

function imageMd(n: JNode, o: O): string {
  const src = str(n.attrs?.src); const alt = str(n.attrs?.alt ?? n.attrs?.title);
  if (o.flavor === 'discord') return /^https?:\/\//i.test(src) ? src : `🖼️ ${alt || 'image'}`;
  return src ? `![${alt}](${src})` : '';
}

const indentLines = (s: string, pad: string) => s.split('\n').map(l => (l ? pad + l : l)).join('\n');
const prefixLines = (s: string, prefix: string) => s.split('\n').map(l => (l ? prefix + l : prefix.trimEnd())).join('\n');

function textOf(n: JNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  return (n.content ?? []).map(textOf).join('');
}

function listMd(n: JNode, o: O, depth: number): string {
  const ordered = n.type === 'orderedList';
  const task = n.type === 'taskList';
  const start = Number(n.attrs?.start ?? 1) || 1;
  const pad = '  '.repeat(depth);
  return (n.content ?? []).map((li, i) => {
    const checked = !!li.attrs?.checked;
    const marker = ordered ? `${start + i}.` : task ? (o.flavor === 'discord' ? (checked ? '☑' : '☐') : `- [${checked ? 'x' : ' '}]`) : '-';
    const [first, ...rest] = li.content ?? [];
    let head = '';
    if (first) head = first.type === 'paragraph' || first.type === 'heading' ? inline(first.content, o) : blockMd(first, o, depth + 1).trim();
    head = head.replace(/\n/g, `\n${pad}  `);
    const tail = rest.map(c => (LIST_TYPES.has(c.type ?? '') ? blockMd(c, o, depth + 1) : indentLines(blockMd(c, o, depth + 1), `${pad}  `))).filter(Boolean).join('\n');
    return `${pad}${marker} ${head}`.trimEnd() + (tail ? `\n${tail}` : '');
  }).join('\n');
}

function cellText(cell: JNode, o: O): string {
  return (cell.content ?? []).map(c => (c.type === 'paragraph' ? inline(c.content, o) : textOf(c))).join(' ').replace(/\n/g, ' ').trim();
}

function tableMd(n: JNode, o: O): string {
  const rows = (n.content ?? []).map(r => (r.content ?? []).map(c => cellText(c, o)));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => [...r, ...Array(cols - r.length).fill('')]);
  if (o.flavor === 'discord') {
    // Bloc de code monospace : colonnes alignées (le texte n'est pas échappé dans un bloc de code).
    const plain = (n.content ?? []).map(r => (r.content ?? []).map(c => textOf(c).replace(/\n/g, ' ').trim()));
    const pr = plain.map(r => [...r, ...Array(cols - r.length).fill('')]);
    const w = Array.from({ length: cols }, (_, j) => Math.min(24, Math.max(3, ...pr.map(r => r[j].length))));
    const fmt = (r: string[]) => r.map((c, j) => (c.length > w[j] ? c.slice(0, w[j] - 1) + '…' : c.padEnd(w[j]))).join(' │ ').trimEnd();
    const lines = [fmt(pr[0]), w.map(x => '─'.repeat(x)).join('─┼─'), ...pr.slice(1).map(fmt)];
    return '```\n' + lines.join('\n') + '\n```';
  }
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  return [`| ${norm[0].map(esc).join(' | ')} |`, `| ${norm[0].map(() => '---').join(' | ')} |`, ...norm.slice(1).map(r => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

function blockMd(n: JNode, o: O, depth = 0): string {
  switch (n.type) {
    case 'paragraph': return escapeLineStart(inline(n.content, o));
    case 'heading': {
      const t = inline(n.content, o);
      if (!t.trim()) return '';
      if (o.headings === 'bold') return `**${t.trim()}**`;
      const lvl = Math.max(1, Math.min(o.flavor === 'discord' ? 3 : 6, Number(n.attrs?.level ?? 1)));
      return `${'#'.repeat(lvl)} ${t}`;
    }
    case 'bulletList': case 'orderedList': case 'taskList': return listMd(n, o, depth);
    case 'blockquote': return prefixLines(blocks(n.content, o, depth).join('\n\n'), '> ');
    case 'codeBlock': {
      const lang = str(n.attrs?.language).replace(/[^\w+#.-]/g, '');
      return '```' + lang + '\n' + textOf(n).replace(/```/g, '`​``') + '\n```';
    }
    case 'horizontalRule': return o.flavor === 'discord' ? '─────────────' : '---';
    case 'image': return imageMd(n, o);
    case 'table': return tableMd(n, o);
    case 'details': {
      const summary = (n.content ?? []).find(c => c.type === 'detailsSummary');
      const body = (n.content ?? []).filter(c => c.type !== 'detailsSummary');
      const s = summary ? inline(summary.content, o) : '';
      const inner = blocks(body.flatMap(b => (b.type === 'detailsContent' ? b.content ?? [] : [b])), o, depth).join('\n\n');
      return o.flavor === 'discord' ? `**▸ ${s}**${inner ? '\n' + inner : ''}` : `<details>\n<summary>${s}</summary>\n\n${inner}\n\n</details>`;
    }
    case 'blockMath': case 'mathBlock': {
      const latex = str(n.attrs?.latex);
      return o.flavor === 'discord' ? '```\n' + latex + '\n```' : `$$\n${latex}\n$$`;
    }
    case 'youtube': case 'embed': case 'video': case 'audio': {
      const src = str(n.attrs?.src ?? n.attrs?.url);
      return src ? (o.flavor === 'discord' ? src : `[${src}](${src})`) : '';
    }
    case 'callout': {
      const icon = str(n.attrs?.emoji ?? n.attrs?.icon ?? '💡');
      return prefixLines(`${icon} ${blocks(n.content, o, depth).join('\n\n')}`, '> ');
    }
    case 'stripeRevenue': return o.flavor === 'discord' ? '' : '_[Bloc Revenus Stripe]_';
    case 'text': return textWithMarks(n, o);
    default: {
      const kids = n.content ?? [];
      if (!kids.length) return n.text ? escapeMarkdown(n.text, o.flavor) : '';
      const isInline = kids.every(k => k.type === 'text' || k.type === 'hardBreak' || k.type === 'mention' || k.type === 'filePin');
      return isInline ? inline(kids, o) : blocks(kids, o, depth).join('\n\n');
    }
  }
}

function blocks(nodes: JNode[] | undefined, o: O, depth: number): string[] {
  return (nodes ?? []).map(n => blockMd(n, o, depth)).filter(s => s.trim() !== '');
}

/** Document TipTap → Markdown. */
export function docToMarkdown(doc: unknown, opts: MdOptions = {}): string {
  const o: O = { flavor: opts.flavor ?? 'standard', headings: opts.headings ?? 'markdown' };
  const root = (doc ?? {}) as JNode;
  const nodes = root.type === 'doc' || !root.type ? root.content : [root];
  return blocks(nodes, o, 0).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Document TipTap → texte brut lisible (pour Jarvis, la recherche, la synthèse vocale). */
export function docToText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: JNode, prefix = '') => {
    if (!n) return;
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') { out.push(prefix + textOf(n)); return; }
    if (n.type === 'listItem' || n.type === 'taskItem') {
      const [first, ...rest] = n.content ?? [];
      out.push(prefix + '- ' + (first ? textOf(first) : ''));
      rest.forEach(c => walk(c, prefix + '  '));
      return;
    }
    if (n.type === 'tableRow') { out.push(prefix + (n.content ?? []).map(c => textOf(c).trim()).join(' | ')); return; }
    if (n.type === 'filePin') { out.push(prefix + '📎 ' + str(n.attrs?.name)); return; }
    (n.content ?? []).forEach(c => walk(c, prefix));
  };
  walk((doc ?? {}) as JNode);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Première image http(s) d'un document. */
export function firstImageUrl(doc: unknown): string | undefined {
  let found: string | undefined;
  const walk = (n: JNode) => {
    if (found || !n) return;
    if (n.type === 'image' && /^https?:\/\//i.test(str(n.attrs?.src))) { found = str(n.attrs?.src); return; }
    (n.content ?? []).forEach(walk);
  };
  walk((doc ?? {}) as JNode);
  return found;
}
