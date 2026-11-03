// Conversions de documents : JSON TipTap ⇄ blocs d'analyse, Markdown (sortie Claude) → JSON TipTap, gabarit guidé.
import { fmtClock, type ScriptBlock } from './heuristics';
import { SECTION_DEFS } from './method';

export interface JSONMark { type: string; attrs?: Record<string, unknown> }
export interface JSONNode { type?: string; text?: string; attrs?: Record<string, unknown>; content?: JSONNode[]; marks?: JSONMark[] }

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);
const isTextblock = (n: JSONNode) => TEXTBLOCKS.has(n.type ?? '') || !!n.content?.some(c => c.type === 'text');
const inlineText = (n: JSONNode): string =>
  (n.content ?? []).map(c => c.type === 'text' ? c.text ?? '' : c.type === 'hardBreak' ? '\n' : c.content ? inlineText(c) : ' ').join('');

/** Blocs d'analyse à partir du JSON TipTap d'une page (sans éditeur monté). */
export function blocksFromJSON(doc: unknown): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  const visit = (n: JSONNode, top: number) => {
    if (isTextblock(n)) {
      out.push({ text: inlineText(n), heading: n.type === 'heading' ? Number(n.attrs?.level ?? 1) : undefined, code: n.type === 'codeBlock' || undefined, top });
      return;
    }
    for (const c of n.content ?? []) visit(c, top);
  };
  ((doc as JSONNode | null)?.content ?? []).forEach((n, i) => visit(n, i));
  return out;
}

/** Vrai si le script contient du texte écrit (au-delà des titres du gabarit). */
export const hasWrittenText = (blocks: ScriptBlock[]) => blocks.some(b => !b.heading && b.text.trim().split(/\s+/).length >= 3);

// ── Markdown → JSON TipTap (sous-ensemble StarterKit) ─────────
const INLINE_RE = /(\*\*|__)(.+?)\1|\*(?!\s)(.+?)(?<!\s)\*|(?<![\p{L}\p{N}])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}])|`([^`]+)`|~~(.+?)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu;
function pushText(out: JSONNode[], text: string, marks: JSONMark[]) {
  if (!text) return;
  out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
}
export function inlineMarkdown(src: string, marks: JSONMark[] = []): JSONNode[] {
  const out: JSONNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'gu');
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) pushText(out, src.slice(last, m.index), marks);
    if (m[1]) out.push(...inlineMarkdown(m[2], [...marks, { type: 'bold' }]));
    else if (m[3] != null) out.push(...inlineMarkdown(m[3], [...marks, { type: 'italic' }]));
    else if (m[4] != null) out.push(...inlineMarkdown(m[4], [...marks, { type: 'italic' }]));
    else if (m[5] != null) pushText(out, m[5], [...marks, { type: 'code' }]);
    else if (m[6] != null) out.push(...inlineMarkdown(m[6], [...marks, { type: 'strike' }]));
    else if (m[7] != null) out.push(...inlineMarkdown(m[7], [...marks, { type: 'link', attrs: { href: m[8] } }]));
    last = m.index + m[0].length;
  }
  if (last < src.length) pushText(out, src.slice(last), marks);
  return out;
}
export const paragraph = (text: string): JSONNode => {
  const content = inlineMarkdown(text);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

/** Convertit le Markdown produit par Claude en document TipTap. Une ligne = un paragraphe (format script). */
export function markdownToDoc(md: string): JSONNode {
  const lines = md.replace(/\r/g, '').split('\n');
  const content: JSONNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```([\w-]*)/.exec(line);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', attrs: { language: fence[1] || null }, ...(buf.length ? { content: [{ type: 'text', text: buf.join('\n') }] } : {}) });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { const c = inlineMarkdown(h[2]); content.push({ type: 'heading', attrs: { level: Math.min(3, h[1].length) }, ...(c.length ? { content: c } : {}) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { content.push({ type: 'horizontalRule' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const paras = buf.filter(l => l.trim()).map(l => paragraph(l.trim()));
      content.push({ type: 'blockquote', content: paras.length ? paras : [{ type: 'paragraph' }] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const row = lines[i++];
        if (/^\s*\|[\s:|-]+\|\s*$/.test(row)) continue;
        const cells = row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length) content.push(paragraph(cells.join(' — ')));
      }
      continue;
    }
    const UL = /^\s*[-*+]\s+(.*)$/, OL = /^\s*(\d+)[.)]\s+(.*)$/;
    const ul = UL.exec(line), ol = OL.exec(line);
    if (ul || ol) {
      const ordered = !ul;
      const items: JSONNode[] = [];
      while (i < lines.length) {
        const m = (ordered ? OL : UL).exec(lines[i]);
        if (!m) break;
        items.push({ type: 'listItem', content: [paragraph((ordered ? m[2] : m[1]).trim())] });
        i++;
      }
      content.push(ordered ? { type: 'orderedList', attrs: { start: Number(ol?.[1]) || 1 }, content: items } : { type: 'bulletList', content: items });
      continue;
    }
    content.push(paragraph(line.trim()));
    i++;
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Gabarit de la structure guidée (titres H2 + paragraphe vide guidé par la méthode). */
export function templateNodes(): JSONNode[] {
  return SECTION_DEFS.flatMap(d => [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: d.heading }] },
    { type: 'paragraph' },
  ]);
}
export const templateDoc = (): JSONNode => ({ type: 'doc', content: templateNodes() });

/** Script lisible par Claude : titres Markdown + horodatage estimé de chaque paragraphe parlé. */
export function scriptToPrompt(blocks: ScriptBlock[], times: (number | null)[], maxChars = 24000): string {
  const lines: string[] = [];
  blocks.forEach((b, i) => {
    if (b.heading) lines.push(`${'#'.repeat(Math.min(3, b.heading))} ${b.text.trim()}`);
    else if (b.text.trim()) lines.push(`${times[i] != null ? `[${fmtClock(times[i] as number)}] ` : ''}${b.text.trim()}`);
  });
  const s = lines.join('\n');
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.floor(maxChars * 0.6)) + '\n[… passage central coupé pour la longueur …]\n' + s.slice(-Math.floor(maxChars * 0.4));
}

/** Retire la balise ```markdown éventuelle autour d'une réponse de Claude. */
export const stripFences = (s: string) => s.replace(/^\s*```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');
