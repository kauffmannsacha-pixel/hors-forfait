// Extension TipTap/ProseMirror de l'assistant script : décorations (timing en marge, soulignements
// ondulés des conseils, placeholders des sections guidées) + utilitaires de positions et de remplacement.
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { fmtClock, type ScriptAnalysis, type ScriptBlock, type TextRange } from './heuristics';
import { sectionDef } from './method';
import { paragraph, type JSONNode } from './doc';

export const scriptAssistKey = new PluginKey<DecorationSet>('prismeScriptAssist');

/** Extension unique (instance stable) à passer en extraExtensions du BlockEditor. */
export const ScriptAssist = Extension.create({
  name: 'prismeScriptAssist',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: scriptAssistKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const next = tr.getMeta(scriptAssistKey) as DecorationSet | undefined;
          if (next) return next;
          return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
        },
      },
      props: { decorations: state => scriptAssistKey.getState(state) },
    })];
  },
});

// ── Index texte ⇄ positions du document ──────────────────────
export interface PMIndex {
  blocks: ScriptBlock[];
  pos: number[];                 // position du nœud textblock
  maps: number[][];              // position doc de chaque caractère (+ position de fin)
  topOf: number[];               // index du bloc de 1er niveau
  tops: { pos: number; size: number }[];
}
export function indexDoc(doc: PMNode): PMIndex {
  const ix: PMIndex = { blocks: [], pos: [], maps: [], topOf: [], tops: [] };
  doc.forEach((top, topPos, topIndex) => {
    ix.tops.push({ pos: topPos, size: top.nodeSize });
    const visit = (node: PMNode, pos: number) => {
      if (node.isTextblock) {
        let text = ''; const map: number[] = [];
        node.forEach((child, off) => {
          const p = pos + 1 + off;
          if (child.isText) { const t = child.text ?? ''; for (let k = 0; k < t.length; k++) map.push(p + k); text += t; }
          else { map.push(p); text += child.type.name === 'hardBreak' ? '\n' : ' '; }
        });
        map.push(pos + 1 + node.content.size);
        ix.blocks.push({ text, heading: node.type.name === 'heading' ? Number(node.attrs.level) || 1 : undefined, code: node.type.spec.code ? true : undefined, top: topIndex });
        ix.pos.push(pos); ix.maps.push(map); ix.topOf.push(topIndex);
        return;
      }
      node.forEach((child, off) => visit(child, pos + 1 + off));
    };
    visit(top, topPos);
  });
  return ix;
}
export function rangeToPos(ix: PMIndex, r: TextRange): { from: number; to: number } | null {
  const m0 = ix.maps[r.b0], m1 = ix.maps[r.b1];
  if (!m0 || !m1) return null;
  const from = m0[Math.max(0, Math.min(r.o0, m0.length - 1))];
  const last = Math.min(r.o1 - 1, m1.length - 2);
  const to = last >= 0 ? m1[last] + 1 : m1[0];
  return to > from ? { from, to } : null;
}
/** Retrouve dans le document un extrait cité par Claude (tolérant aux espaces, apostrophes et guillemets). */
export function findExcerpt(ix: PMIndex, excerpt: string): { from: number; to: number } | null {
  const re = excerptRegex(excerpt);
  if (!re) return null;
  const words = excerpt.trim().split(/\s+/);
  const prefix = words.length > 6 ? excerptRegex(words.slice(0, 6).join(' ')) : null;
  for (const rx of [re, prefix]) {
    if (!rx) continue;
    for (let b = 0; b < ix.blocks.length; b++) {
      if (ix.blocks[b].heading) continue;
      const m = rx.exec(ix.blocks[b].text);
      if (m) return rangeToPos(ix, { b0: b, o0: m.index, b1: b, o1: m.index + m[0].length });
    }
  }
  return null;
}
function excerptRegex(ex: string): RegExp | null {
  const t = ex.trim().replace(/^[\s"«“'…]+|[\s"»”'…]+$/g, '');
  if (t.length < 6) return null;
  let src = '';
  for (const c of t) {
    if (/\s/.test(c)) src += '\\s+';
    else if (/['’‘`´]/.test(c)) src += "['’‘`´]";
    else if (/["«»“”„]/.test(c)) src += '["«»“”„]\\s*';
    else src += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  try { return new RegExp(src.replace(/(?:\\s\+)+/g, '\\s+'), 'iu'); } catch { return null; }
}

// ── Décorations ───────────────────────────────────────────────
export interface PlacedIssue {
  id: string; source: 'local' | 'claude'; type: string; severity: 'error' | 'warn' | 'info';
  message: string; fix: string; method?: string; citation?: string | null;
  from?: number; to?: number; excerpt?: string; t?: number;
}
const shortDur = (s: number) => { const r = Math.round(s); return r < 60 ? `${r} s` : `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };

export function buildDecorations(doc: PMNode, ix: PMIndex, a: ScriptAnalysis, issues: PlacedIssue[], flash?: { from: number; to: number } | null): DecorationSet {
  const decos: Decoration[] = [];
  const sectionByBlock = new Map(a.sections.filter(s => s.b >= 0).map(s => [s.b, s]));
  // 1. Timing en marge (début de chaque bloc parlé, durée / cible de chaque section)
  const done = new Set<number>();
  ix.blocks.forEach((blk, b) => {
    const top = ix.topOf[b];
    const time = a.blockTimes[b];
    if (done.has(top) || time == null) return;
    done.add(top);
    const t = ix.tops[top];
    const sec = sectionByBlock.get(b);
    if (sec && blk.heading && blk.heading <= 2) {
      const d = sec.kind === 'notes' ? 'non parlé' : `${shortDur(sec.dur)}${sec.target ? ` / ${shortDur(sec.target)}` : ''}`;
      decos.push(Decoration.node(t.pos, t.pos + t.size, { class: `sc-t sc-sec sc-${sec.status}`, 'data-sc-t': fmtClock(sec.start), 'data-sc-d': d }));
    } else decos.push(Decoration.node(t.pos, t.pos + t.size, { class: blk.heading ? 'sc-t sc-beat' : 'sc-t', 'data-sc-t': fmtClock(time) }));
  });
  // 2. Placeholder guidé : paragraphe vide juste sous un titre de section
  ix.blocks.forEach((blk, b) => {
    if (!(blk.heading && blk.heading <= 2) || b + 1 >= ix.blocks.length) return;
    const nb = ix.blocks[b + 1];
    if (nb.heading || nb.text.length || ix.topOf[b + 1] !== ix.topOf[b] + 1) return;
    const node = doc.nodeAt(ix.pos[b + 1]);
    const def = sectionDef(sectionByBlock.get(b)?.kind ?? 'libre');
    if (!node || node.type.name !== 'paragraph' || node.content.size || !def) return;
    decos.push(Decoration.node(ix.pos[b + 1], ix.pos[b + 1] + node.nodeSize, { class: 'sc-ph', 'data-sc-ph': def.guidance }));
  });
  // 3. Conseils : soulignement ondulé
  for (const is of issues) {
    if (is.from == null || is.to == null || is.to <= is.from || is.to > doc.content.size) continue;
    decos.push(Decoration.inline(is.from, is.to, { class: `sc-sug sc-sug-${is.severity}${is.source === 'claude' ? ' sc-sug-ai' : ''}`, 'data-sug': is.id }, { id: is.id }));
  }
  // 4. Surbrillance temporaire (« Voir »)
  if (flash && flash.to > flash.from && flash.to <= doc.content.size) decos.push(Decoration.inline(flash.from, flash.to, { class: 'sc-flash' }));
  return DecorationSet.create(doc, decos);
}
export function pushDecorations(editor: Editor, set: DecorationSet) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(scriptAssistKey, set).setMeta('addToHistory', false));
}

// ── Contenu ───────────────────────────────────────────────────
/** Retire marques / nœuds inconnus du schéma (évite qu'un contenu invalide vide le document). */
export function sanitizeJSON(n: JSONNode, schema: Schema): JSONNode {
  const out: JSONNode = { ...n };
  if (n.marks) { const marks = n.marks.filter(m => !!schema.marks[m.type]); if (marks.length) out.marks = marks; else delete out.marks; }
  if (n.content) {
    out.content = n.content.flatMap((c): JSONNode[] => {
      if (c.type && c.type !== 'text' && !schema.nodes[c.type]) return (c.content ?? []).map(cc => sanitizeJSON(cc, schema));
      return [sanitizeJSON(c, schema)];
    });
  }
  return out;
}
/** Remplace [from, to] par un texte réécrit (une ligne = un paragraphe), en une seule étape d'historique. */
export function replaceWithText(editor: Editor, from: number, to: number, text: string): boolean {
  const { schema, doc } = editor.state;
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const single = !doc.textBetween(from, to, '\n', ' ').includes('\n');
  const json = single ? [paragraph(lines.join(' '))] : lines.map(l => paragraph(l));
  const nodes = json.map(j => schema.nodeFromJSON(sanitizeJSON(j, schema)));
  editor.view.dispatch(editor.state.tr.replace(from, to, new Slice(Fragment.fromArray(nodes), 1, 1)).scrollIntoView());
  return true;
}
/** Fait défiler jusqu'à une position et place le curseur. */
export function revealPos(editor: Editor, pos: number, smooth = true) {
  if (editor.isDestroyed) return;
  const p = Math.max(0, Math.min(pos, editor.state.doc.content.size));
  try {
    const { node } = editor.view.domAtPos(p);
    const el = node instanceof Element ? node : node.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    editor.commands.setTextSelection(p);
  } catch { /* position hors vue */ }
}
/** Texte à lire (prompteur) : uniquement les phrases parlées, un paragraphe par bloc. */
export function spokenText(a: ScriptAnalysis): string {
  const out: string[] = []; let lastB = -1;
  for (const s of a.sentences) {
    if (s.b !== lastB) { out.push(s.text); lastB = s.b; } else out[out.length - 1] += ' ' + s.text;
  }
  return out.join('\n\n');
}
