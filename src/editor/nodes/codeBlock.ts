// Bloc de code : coloration lowlight INCRÉMENTALE (seuls les blocs modifiés sont recolorés),
// sélecteur de langage et bouton « Copier » (NodeView DOM légère).
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createLowlight, common } from 'lowlight';

export const lowlight = createLowlight(common);

export const CODE_LANGUAGES: [string, string][] = [
  ['', 'Détection auto'], ['plaintext', 'Texte brut'], ['lua', 'Lua / Luau'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
  ['python', 'Python'], ['json', 'JSON'], ['xml', 'HTML / XML'], ['css', 'CSS'], ['scss', 'SCSS'], ['bash', 'Bash'], ['shell', 'Shell'],
  ['sql', 'SQL'], ['csharp', 'C#'], ['cpp', 'C++'], ['c', 'C'], ['java', 'Java'], ['kotlin', 'Kotlin'], ['swift', 'Swift'], ['go', 'Go'],
  ['rust', 'Rust'], ['php', 'PHP'], ['ruby', 'Ruby'], ['markdown', 'Markdown'], ['yaml', 'YAML'], ['ini', 'INI / TOML'], ['diff', 'Diff'],
  ['graphql', 'GraphQL'], ['r', 'R'], ['makefile', 'Makefile'], ['objectivec', 'Objective-C'], ['perl', 'Perl'], ['vbnet', 'VB.NET'],
];

type HastNode = { type: string; value?: string; children?: HastNode[]; properties?: { className?: string[] } };

function flatten(nodes: HastNode[], classes: string[] = []): { text: string; classes: string[] }[] {
  return nodes.flatMap(n => {
    const cls = [...classes, ...(n.properties?.className ?? [])];
    if (n.children) return flatten(n.children, cls);
    return [{ text: n.value ?? '', classes: cls }];
  });
}

/** Décorations de coloration d'un bloc de code situé à `pos`. */
export function highlightBlock(node: PMNode, pos: number, defaultLanguage: string | null): Decoration[] {
  const text = node.textContent;
  if (!text) return [];
  const lang = (node.attrs.language as string | null) || defaultLanguage;
  let tree: { children: HastNode[] };
  try {
    tree = (lang && lowlight.registered(lang) ? lowlight.highlight(lang, text) : text.length < 20_000 ? lowlight.highlightAuto(text) : { children: [] }) as unknown as { children: HastNode[] };
  } catch { return []; }
  const out: Decoration[] = []; let from = pos + 1;
  for (const seg of flatten(tree.children)) {
    const to = from + seg.text.length;
    if (seg.classes.length && to > from) out.push(Decoration.inline(from, to, { class: seg.classes.join(' ') }));
    from = to;
  }
  return out;
}

function incrementalHighlight(name: string, defaultLanguage: string | null) {
  const key = new PluginKey<DecorationSet>('codeHighlight');
  const all = (doc: PMNode) => {
    const decos: Decoration[] = [];
    doc.descendants((n, pos) => { if (n.type.name === name) { decos.push(...highlightBlock(n, pos, defaultLanguage)); return false; } return true; });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, { doc }) => all(doc),
      apply(tr, set) {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        const ranges: [number, number][] = [];
        tr.mapping.maps.forEach((map, i) => {
          const rest = tr.mapping.slice(i + 1);
          map.forEach((_os, _oe, ns, ne) => ranges.push([rest.map(ns, -1), rest.map(ne, 1)]));
        });
        const size = tr.doc.content.size;
        const done = new Set<number>();
        for (const [a, b] of ranges) {
          const from = Math.max(0, Math.min(a, size)); const to = Math.max(from, Math.min(b, size));
          tr.doc.nodesBetween(from, to, (n, pos) => {
            if (n.type.name === name) {
              if (!done.has(pos)) {
                done.add(pos);
                next = next.remove(next.find(pos, pos + n.nodeSize));
                next = next.add(tr.doc, highlightBlock(n, pos, defaultLanguage));
              }
              return false;
            }
            // un bloc qui n'est plus du code ne doit garder aucune couleur
            if (n.isTextblock) { const stale = next.find(pos, pos + n.nodeSize); if (stale.length) next = next.remove(stale); return false; }
            return true;
          });
        }
        return next;
      },
    },
    props: { decorations: state => key.getState(state) },
  });
}

export const CodeBlock = CodeBlockLowlight.extend({
  addProseMirrorPlugins() {
    // On garde les plugins de base (collage VS Code…) mais on remplace la coloration complète par la version incrémentale.
    const parent = (this.parent?.() ?? []).filter(p => !(p.spec.key && (p.spec.key as unknown as { key: string }).key.startsWith('lowlight')));
    return [...parent, incrementalHighlight(this.name, this.options.defaultLanguage ?? null)];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'code-block';
      const bar = document.createElement('div'); bar.className = 'code-bar'; bar.contentEditable = 'false';
      const select = document.createElement('select'); select.className = 'code-lang'; select.title = 'Langage';
      for (const [v, l] of CODE_LANGUAGES) { const o = document.createElement('option'); o.value = v; o.textContent = l; select.appendChild(o); }
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'code-copy'; copy.textContent = 'Copier';
      bar.append(select, copy);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.appendChild(code);
      dom.append(bar, pre);
      const render = () => {
        const lang = (current.attrs.language as string | null) ?? '';
        if (![...select.options].some(o => o.value === lang)) { const o = document.createElement('option'); o.value = lang; o.textContent = lang; select.appendChild(o); }
        select.value = lang;
        code.className = lang ? `language-${lang}` : '';
        select.disabled = !editor.isEditable;
      };
      render();
      select.addEventListener('change', () => {
        const pos = getPos(); if (typeof pos !== 'number') return;
        editor.chain().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: select.value || null }); return true; }).focus().run();
      });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(current.textContent); copy.textContent = 'Copié ✓'; }
        catch { copy.textContent = 'Échec'; }
        setTimeout(() => { copy.textContent = 'Copier'; }, 1400);
      });
      return {
        dom, contentDOM: code,
        update: n => { if (n.type !== current.type) return false; current = n; render(); return true; },
        stopEvent: e => bar.contains(e.target as globalThis.Node),
        ignoreMutation: m => bar.contains(m.target as globalThis.Node),
      };
    };
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true, tabSize: 2 });
