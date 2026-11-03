// Bloc « sous-page » : lien vers une page (icône + titre en direct). Clic → ouverture.
import { Node, mergeAttributes } from '@tiptap/core';
import { displayTitle, isInTrash, usePages } from '../../db/pages';
import { openPage } from '../../ui/appState';

export const PageBlock = Node.create({
  name: 'pageBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: { default: null, parseHTML: el => el.getAttribute('data-page-id'), renderHTML: a => ({ 'data-page-id': a.pageId }) },
      title: { default: '', parseHTML: el => el.getAttribute('data-title') ?? el.textContent ?? '', renderHTML: a => ({ 'data-title': a.title }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="page-block"]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'page-block', class: 'page-block' }), `📄 ${node.attrs.title || 'Page'}`];
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'page-block'; dom.contentEditable = 'false'; dom.tabIndex = -1;
      const icon = document.createElement('span'); icon.className = 'pb-icon';
      const title = document.createElement('span'); title.className = 'pb-title';
      const arrow = document.createElement('span'); arrow.className = 'pb-arrow'; arrow.textContent = '↗';
      dom.append(icon, title, arrow);
      const render = () => {
        const p = current.attrs.pageId ? usePages.getState().pages[current.attrs.pageId] : undefined;
        icon.textContent = p?.icon || (p?.kind === 'database' ? '🗃️' : '📄');
        title.textContent = p ? displayTitle(p) : (current.attrs.title || 'Page introuvable');
        dom.classList.toggle('missing', !p || isInTrash(p.id));
        dom.title = !p ? 'Cette page a été supprimée' : isInTrash(p.id) ? 'Cette page est dans la corbeille' : 'Ouvrir la page';
      };
      render();
      let last = usePages.getState().pages[current.attrs.pageId];
      const unsub = usePages.subscribe(s => { const p = s.pages[current.attrs.pageId]; if (p !== last) { last = p; render(); } });
      dom.addEventListener('click', e => {
        e.preventDefault();
        const p = current.attrs.pageId ? usePages.getState().pages[current.attrs.pageId] : undefined;
        if (p) openPage(p.id);
      });
      return {
        dom,
        update: n => { if (n.type !== current.type) return false; current = n; render(); return true; },
        stopEvent: e => e.type === 'click' || e.type === 'mousedown',
        ignoreMutation: () => true,
        destroy: unsub,
      };
    };
  },
});
