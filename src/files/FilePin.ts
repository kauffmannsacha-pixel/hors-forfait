// Nœud TipTap inline atomique `filePin` : une « puce » fichier dans la phrase (icône + nom), comme une mention.
// Sélectionnable, supprimable comme un caractère, copiable (HTML span[data-file-pin]), aperçu au survol,
// clic → panneau latéral « file », Ctrl+clic / double-clic → application Windows par défaut.
import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import type { VaultFile } from '../db/types';
import { openSidePanel } from '../ui/appState';
import { FILE_PIN_MIME, FILE_PIN_NODE } from './api';
import { fileJob, isNativeDragActive } from './dragDrop';
import { insertPins, pinJobsAt, placeholderPlugin, type PinAttrs } from './insert';
import { fileKind, iconSvg, KIND_META, LINK_SVG, truncateMiddle, WARN_SVG } from './kinds';
import { hidePinPopover, hidePinPopoverSoon, isPopoverFor, keepPinPopover, showPinPopover, usePinPopover } from './popover';
import { attempt, open } from './service';
import { useVault } from './store';

const HOVER_DELAY = 350;
const attrsOf = (n: PMNode): PinAttrs => ({ hash: String(n.attrs.hash ?? ''), name: String(n.attrs.name ?? 'fichier'), mime: String(n.attrs.mime ?? ''), linked: !!n.attrs.linked });

class FilePinView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private unsub: () => void;
  private icon: HTMLElement;
  private label: HTMLElement;
  private badge: HTMLElement;

  constructor(node: PMNode) {
    this.node = node;
    const el = document.createElement('span');
    el.className = 'file-pin';
    el.setAttribute('data-file-pin', '');
    this.icon = document.createElement('span'); this.icon.className = 'file-pin-icon';
    this.label = document.createElement('span'); this.label.className = 'file-pin-name';
    this.badge = document.createElement('span'); this.badge.className = 'file-pin-badge';
    el.append(this.icon, this.label, this.badge);
    this.dom = el;
    this.render();
    el.addEventListener('pointerenter', this.onEnter);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('click', this.onClick);
    el.addEventListener('dblclick', this.onDblClick);
    el.addEventListener('dragstart', this.onDragStart);
    // Redessine la puce quand l'état du fichier change (introuvable, relocalisé…).
    this.unsub = useVault.subscribe((s, prev) => {
      const h = this.attrs.hash;
      if (s.files[h] !== prev.files[h] || s.loaded !== prev.loaded) this.render();
    });
  }

  private get attrs() { return attrsOf(this.node); }

  private render() {
    const a = this.attrs;
    const st = useVault.getState();
    const entry = st.files[a.hash];
    const kind = fileKind(a.name, a.mime);
    // Inconnu de l'index une fois chargé (collé depuis une autre machine, supprimé du vault) = introuvable.
    const missing = entry ? !!entry.missing : st.loaded;
    const linked = entry ? entry.linked : a.linked;
    this.dom.dataset.kind = kind;
    this.dom.style.setProperty('--kind', KIND_META[kind].color);
    this.dom.classList.toggle('is-missing', missing);
    this.dom.classList.toggle('is-linked', linked);
    this.icon.innerHTML = iconSvg(kind, 15);
    this.label.textContent = truncateMiddle(a.name, 30);
    this.badge.innerHTML = missing ? WARN_SVG : linked ? LINK_SVG : '';
    this.badge.hidden = !missing && !linked;
    this.dom.setAttribute('aria-label', `${KIND_META[kind].label} : ${a.name}${missing ? ' (introuvable)' : linked ? ' (lié)' : ''}`);
  }

  private onEnter = (e: PointerEvent) => {
    if (e.buttons) return; // pas pendant un glisser
    clearTimeout(this.hoverTimer);
    if (isPopoverFor(this.dom)) { keepPinPopover(); return; }
    this.hoverTimer = setTimeout(() => { if (this.dom.isConnected) showPinPopover(this.dom, this.attrs); }, HOVER_DELAY);
  };
  private onLeave = () => { clearTimeout(this.hoverTimer); if (isPopoverFor(this.dom)) hidePinPopoverSoon(); };
  private onDown = () => { clearTimeout(this.hoverTimer); };
  private onClick = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const { hash } = this.attrs;
    if (!hash) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); hidePinPopover(); attempt(() => open(hash, 'system')); return; }
    if (e.detail > 1) return; // le double-clic est géré à part
    hidePinPopover();
    openSidePanel('file', { hash });
  };
  private onDblClick = (e: MouseEvent) => { e.preventDefault(); const { hash } = this.attrs; if (hash) attempt(() => open(hash, 'system')); };
  private onDragStart = (e: DragEvent) => {
    hidePinPopover();
    // Type dédié : permet de déposer la puce dans un autre éditeur ou module (mail…).
    e.dataTransfer?.setData(FILE_PIN_MIME, JSON.stringify(this.attrs));
  };

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const changed = JSON.stringify(node.attrs) !== JSON.stringify(this.node.attrs);
    this.node = node;
    if (changed) this.render();
    return true;
  }
  ignoreMutation() { return true; }
  stopEvent() { return false; }
  destroy() {
    clearTimeout(this.hoverTimer);
    this.unsub();
    if (isPopoverFor(this.dom)) hidePinPopover();
  }
}

/** Puce actuellement sélectionnée (NodeSelection). */
function selectedPin(editor: Editor): { node: PMNode; pos: number } | null {
  const sel = editor.state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === FILE_PIN_NODE ? { node: sel.node, pos: sel.from } : null;
}

/** Supprime la puce juste avant/après le curseur, comme un caractère. */
function deleteAdjacentPin(editor: Editor, dir: -1 | 1): boolean {
  const { state } = editor;
  if (!state.selection.empty) return false;
  const $c = state.selection.$from;
  const node = dir < 0 ? $c.nodeBefore : $c.nodeAfter;
  if (!node || node.type.name !== FILE_PIN_NODE) return false;
  const from = dir < 0 ? $c.pos - node.nodeSize : $c.pos;
  editor.view.dispatch(state.tr.delete(from, from + node.nodeSize).scrollIntoView());
  return true;
}

/** Le presse-papiers ne contient-il que des fichiers (et éventuellement une balise <img>) ? */
function preferFilesOverClipboardText(cd: DataTransfer): boolean {
  if (cd.getData('text/plain').trim()) return false;
  const html = cd.getData('text/html');
  if (!html.trim()) return true;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return !doc.body.textContent?.trim();
}

const dropKey = new PluginKey('filePinDrop');

export const FilePin = Node.create({
  name: FILE_PIN_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  priority: 110, // avant les gestionnaires génériques de dépôt/collage

  addAttributes() {
    return {
      hash: { default: '', parseHTML: el => el.getAttribute('data-hash') ?? '', renderHTML: a => ({ 'data-hash': a.hash }) },
      name: {
        default: 'fichier',
        parseHTML: el => el.getAttribute('data-name') || el.textContent?.replace(/^📎\s*/, '').trim() || 'fichier',
        renderHTML: a => ({ 'data-name': a.name }),
      },
      mime: { default: 'application/octet-stream', parseHTML: el => el.getAttribute('data-mime') || 'application/octet-stream', renderHTML: a => ({ 'data-mime': a.mime }) },
      linked: { default: false, parseHTML: el => el.getAttribute('data-linked') === 'true', renderHTML: a => ({ 'data-linked': a.linked ? 'true' : 'false' }) },
    };
  },

  parseHTML() { return [{ tag: 'span[data-file-pin]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-file-pin': '', class: 'file-pin' }, HTMLAttributes), `📎 ${node.attrs.name}`];
  },
  renderText({ node }) { return `📎 ${node.attrs.name}`; },

  addNodeView() { return ({ node }) => new FilePinView(node); },

  addKeyboardShortcuts() {
    return {
      // Puce sélectionnée : Entrée = panneau d'aperçu, Ctrl+Entrée = application par défaut, Espace = coup d'œil.
      Enter: () => { const s = selectedPin(this.editor); if (!s) return false; hidePinPopover(); openSidePanel('file', { hash: s.node.attrs.hash }); return true; },
      'Mod-Enter': () => { const s = selectedPin(this.editor); if (!s) return false; const h = String(s.node.attrs.hash); attempt(() => open(h, 'system')); return true; },
      Space: () => {
        const s = selectedPin(this.editor); if (!s) return false;
        const dom = this.editor.view.nodeDOM(s.pos);
        const st = usePinPopover.getState();
        if (st.quickLook && st.attrs?.hash === s.node.attrs.hash) hidePinPopover();
        else if (dom instanceof HTMLElement) showPinPopover(dom, attrsOf(s.node), true);
        return true;
      },
      Escape: () => { if (!usePinPopover.getState().attrs) return false; hidePinPopover(); return true; },
      Backspace: () => deleteAdjacentPin(this.editor, -1),
      Delete: () => deleteAdjacentPin(this.editor, 1),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      placeholderPlugin(),
      new Plugin({
        key: dropKey,
        props: {
          handleDrop(view, event, _slice, moved) {
            const dt = event.dataTransfer;
            if (!dt || moved) return false;
            const at = () => view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.to;
            const custom = dt.getData(FILE_PIN_MIME);
            if (custom && !dt.types.includes('text/html')) {
              // Puce glissée depuis la vue Fichiers / le panneau d'aperçu / un autre module.
              try {
                const a = JSON.parse(custom) as Partial<VaultFile>;
                if (!a.hash) return false;
                event.preventDefault();
                const f = useVault.getState().files[a.hash];
                insertPins(editor, at(), [f ?? { hash: a.hash, name: a.name ?? 'fichier', mime: a.mime ?? '', linked: !!a.linked, size: 0, path: '', addedAt: 0 }]);
                return true;
              } catch { return false; }
            }
            const files = Array.from(dt.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            if (isNativeDragActive()) return true; // Tauri : le dépôt natif (chemins) s'en charge
            pinJobsAt(editor, at(), files.map(f => fileJob(f)));
            return true;
          },
          handlePaste(view, event) {
            const cd = event.clipboardData;
            const files = Array.from(cd?.files ?? []);
            if (!cd || !files.length || !preferFilesOverClipboardText(cd)) return false;
            event.preventDefault();
            if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection());
            pinJobsAt(editor, view.state.selection.from, files.map(f => fileJob(f, true)));
            return true;
          },
          handleDOMEvents: {
            // Le popover ne doit pas gêner la frappe ou le défilement.
            keydown: (_v, e) => { if (e.key !== ' ' && e.key !== 'Escape' && !usePinPopover.getState().quickLook) hidePinPopover(); return false; },
          },
        },
      }),
    ];
  },
});
