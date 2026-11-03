// Conversion du contenu d'une page (JSON TipTap) en Markdown lisible par Claude (pur, testable),
// et extraction des fichiers épinglés (nœuds filePin et blocs média du vault).
import { FILE_PIN_NODE } from '../files/api';

export interface PMNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface PageFileRef { hash: string; name: string; mime: string; node: string }

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

// ───────────────────────────── En ligne ─────────────────────────────

const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'] as const;
type MarkName = typeof MARK_ORDER[number];
const markKey = (n: PMNode) => (n.marks ?? []).map(m => m.type + (m.type === 'link' ? '=' + s(m.attrs?.href) : '')).sort().join('|');

function wrap(text: string, marks: PMNode['marks']): string {
  if (!text) return text;
  const has = (t: MarkName) => (marks ?? []).some(m => m.type === t);
  // Les espaces de bord restent hors des marqueurs (« ** gras ** » serait invalide).
  const lead = /^\s*/.exec(text)?.[0] ?? ''; const trail = /\s*$/.exec(text)?.[0] ?? '';
  let core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  if (has('code')) core = core.includes('`') ? '`` ' + core + ' ``' : '`' + core + '`';
  if (has('strike')) core = `~~${core}~~`;
  if (has('italic')) core = `*${core}*`;
  if (has('bold')) core = `**${core}**`;
  const link = (marks ?? []).find(m => m.type === 'link');
  if (link && s(link.attrs?.href)) core = `[${core}](${s(link.attrs?.href)})`;
  return lead + core + trail;
}

function inlineAtom(n: PMNode): string | null {
  switch (n.type) {
    case 'hardBreak': return '\n';
    case 'mention': return '@' + (s(n.attrs?.label) || s(n.attrs?.title) || s(n.attrs?.id));
    case 'inlineMath': return `$${s(n.attrs?.latex)}$`;
    case FILE_PIN_NODE: return `[📎 ${s(n.attrs?.name) || 'fichier'}]`;
    case 'image': return imageMd(n);
    case 'emoji': return s(n.attrs?.emoji) || s(n.attrs?.name);
    case 'date': case 'dateMention': return s(n.attrs?.label) || s(n.attrs?.date);
    default: return null;
  }
}

function imageMd(n: PMNode): string {
  const src = s(n.attrs?.src); const alt = s(n.attrs?.alt) || s(n.attrs?.title) || 'image';
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return `[🖼 ${alt}]`;
  if (/^https?:\/\/(asset\.localhost|tauri\.localhost)|^asset:/.test(src)) return `[🖼 ${alt}]`;
  return `![${alt}](${src})`;
}

/** Contenu en ligne d'un bloc (texte + marques + atomes). */
export function inlineToMd(nodes: PMNode[] | undefined): string {
  if (!nodes?.length) return '';
  let out = ''; let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.type === 'text') {
      // Regroupe les nœuds texte consécutifs portant les mêmes marques.
      const key = markKey(n); let text = n.text ?? ''; let j = i + 1;
      while (j < nodes.length && nodes[j].type === 'text' && markKey(nodes[j]) === key) { text += nodes[j].text ?? ''; j++; }
      out += wrap(text, n.marks); i = j; continue;
    }
    const atom = inlineAtom(n);
    if (atom !== null) out += atom;
    else if (n.content) out += inlineToMd(n.content);
    else if (n.text) out += n.text;
    i++;
  }
  return out;
}

// ───────────────────────────── Blocs ─────────────────────────────

const indent = (text: string, pad: string) => text.split('\n').map(l => (l ? pad + l : l)).join('\n');
const quote = (text: string) => text.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');

function cellText(cell: PMNode): string {
  return (cell.content ?? []).map(b => (b.type === 'paragraph' || b.type === 'heading' ? inlineToMd(b.content) : blockToMd(b, 0)))
    .filter(Boolean).join('<br>').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function tableMd(n: PMNode): string {
  const rows = (n.content ?? []).filter(r => r.type === 'tableRow').map(r => (r.content ?? []).map(cellText));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => [...r, ...Array(width - r.length).fill('')]);
  const line = (r: string[]) => '| ' + r.map(c => c || ' ').join(' | ') + ' |';
  return [line(norm[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...norm.slice(1).map(line)].join('\n');
}

function listMd(n: PMNode, ordered: boolean, depth: number): string {
  let k = Number(n.attrs?.start ?? 1); if (!Number.isFinite(k)) k = 1;
  return (n.content ?? []).map(item => {
    const marker = n.type === 'taskList' || item.type === 'taskItem'
      ? (item.attrs?.checked ? '- [x] ' : '- [ ] ')
      : ordered ? `${k++}. ` : '- ';
    const blocks = item.content ?? [];
    const first = blocks[0];
    const head = first && (first.type === 'paragraph' || first.type === 'heading') ? inlineToMd(first.content) : (first ? blockToMd(first, depth + 1) : '');
    const rest = blocks.slice(1).map(b => blockToMd(b, depth + 1)).filter(Boolean).join('\n');
    const pad = ' '.repeat(marker.length);
    return marker + indent(head, pad).trimStart() + (rest ? '\n' + indent(rest, pad) : '');
  }).join('\n');
}

/** Un bloc en Markdown. */
export function blockToMd(n: PMNode, depth = 0): string {
  switch (n.type) {
    case 'doc': return blocksToMd(n.content);
    case 'paragraph': return inlineToMd(n.content);
    case 'heading': { const lvl = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))); const t = inlineToMd(n.content); return t ? '#'.repeat(lvl) + ' ' + t : ''; }
    case 'bulletList': return listMd(n, false, depth);
    case 'orderedList': return listMd(n, true, depth);
    case 'taskList': return listMd(n, false, depth);
    case 'listItem': case 'taskItem': return listMd({ type: n.type === 'taskItem' ? 'taskList' : 'bulletList', content: [n] }, false, depth);
    case 'blockquote': return quote(blocksToMd(n.content));
    case 'callout': { const body = blocksToMd(n.content); return quote(`${s(n.attrs?.emoji) || '💡'} ${body}`); }
    case 'codeBlock': {
      const code = (n.content ?? []).map(c => c.text ?? '').join('');
      const fence = code.includes('```') ? '````' : '```';
      return `${fence}${s(n.attrs?.language)}\n${code}\n${fence}`;
    }
    case 'horizontalRule': return '---';
    case 'table': return tableMd(n);
    case 'details': {
      const summary = (n.content ?? []).find(c => c.type === 'detailsSummary');
      const body = (n.content ?? []).filter(c => c.type !== 'detailsSummary');
      const head = summary ? inlineToMd(summary.content) : '';
      const inner = blocksToMd(body.flatMap(b => (b.type === 'detailsContent' ? b.content ?? [] : [b])));
      return `▸ ${head}` + (inner ? '\n' + indent(inner, '  ') : '');
    }
    case 'columns': return (n.content ?? []).map(c => blocksToMd(c.content)).filter(Boolean).join('\n\n');
    case 'column': return blocksToMd(n.content);
    case 'pageBlock': return `📄 ${s(n.attrs?.title) || 'Page'}${n.attrs?.pageId ? ` (page id : ${s(n.attrs.pageId)})` : ''}`;
    case 'blockMath': return `$$\n${s(n.attrs?.latex)}\n$$`;
    case 'image': return imageMd(n);
    case 'video': return `[🎬 ${s(n.attrs?.name) || s(n.attrs?.src) || 'vidéo'}]`;
    case 'audio': return `[🔊 ${s(n.attrs?.name) || s(n.attrs?.src) || 'audio'}]`;
    case 'fileBlock': return `[📎 ${s(n.attrs?.name) || 'fichier'}]`;
    case 'youtube': return `[▶ YouTube : ${s(n.attrs?.src)}]`;
    case 'embed': return `[Intégration : ${s(n.attrs?.url) || s(n.attrs?.src)}]`;
    case 'text': return n.text ?? '';
    default: {
      if (n.content?.length) {
        const allInline = n.content.every(c => c.type === 'text' || inlineAtom(c) !== null);
        return allInline ? inlineToMd(n.content) : blocksToMd(n.content);
      }
      const atom = inlineAtom(n);
      if (atom !== null) return atom;
      return s(n.attrs?.text) || s(n.attrs?.label) || s(n.attrs?.title);
    }
  }
}

/** Liste de blocs séparés par une ligne vide (les listes consécutives restent compactes). */
export function blocksToMd(nodes: PMNode[] | undefined): string {
  return (nodes ?? []).map(b => blockToMd(b)).filter(t => t.trim() !== '').join('\n\n');
}

/** Document TipTap complet → Markdown. */
export function docToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const d = doc as PMNode;
  return (d.type === 'doc' ? blocksToMd(d.content) : blockToMd(d)).replace(/\n{3,}/g, '\n\n').trim();
}

/** Texte brut (sans Markdown), pour les extraits de recherche. */
export function docToPlainText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: PMNode | undefined) => {
    if (!n) return;
    if (n.type === 'text') { out.push(n.text ?? ''); return; }
    if (n.type === 'hardBreak') { out.push(' '); return; }
    const atom = n.type && n.type !== 'image' ? inlineAtom(n) : null;
    if (atom !== null) { out.push(atom.replace(/^\[|\]$/g, '')); return; }
    (n.content ?? []).forEach(walk);
    out.push(' ');
  };
  walk(doc as PMNode);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Fichiers du vault référencés par la page (filePin en priorité, puis blocs média), sans doublon. */
export function extractFileRefs(doc: unknown): PageFileRef[] {
  const out: PageFileRef[] = []; const seen = new Set<string>();
  const walk = (n: PMNode | undefined) => {
    if (!n) return;
    const hash = s(n.attrs?.hash);
    if (hash && (n.type === FILE_PIN_NODE || n.type === 'fileBlock' || n.type === 'video' || n.type === 'audio' || n.type === 'image') && !seen.has(hash)) {
      seen.add(hash);
      out.push({ hash, name: s(n.attrs?.name) || s(n.attrs?.alt) || 'fichier', mime: s(n.attrs?.mime), node: n.type ?? '' });
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc as PMNode);
  // Les épinglages en ligne d'abord (ce sont « les fichiers épinglés » au sens de Prisme).
  return out.sort((a, b) => Number(b.node === FILE_PIN_NODE) - Number(a.node === FILE_PIN_NODE));
}

/** Coupe un texte trop long en le signalant explicitement. */
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n\n[… tronqué : ${text.length.toLocaleString('fr-FR')} caractères au total]`, truncated: true };
}
