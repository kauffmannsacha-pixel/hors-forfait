// Blocs médias : image (redimensionnable), vidéo, audio, fichier. Source = vault (hash) ou URL.
import { Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { formatBytes, openMedia, resolveMediaSrc } from '../media';

const dataAttr = (name: string, def: unknown = null) => ({
  default: def,
  parseHTML: (el: HTMLElement) => {
    const v = el.getAttribute('data-' + name);
    if (v === null) return def;
    return name === 'size' ? Number(v) : v;
  },
  renderHTML: (a: Record<string, unknown>) => (a[name] === null || a[name] === undefined || a[name] === '' ? {} : { ['data-' + name]: a[name] }),
});

/** Image TipTap + identifiant vault (`hash`). */
export const PrismeImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), hash: dataAttr('hash') };
  },
}).configure({ allowBase64: true, inline: false, resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 60, minHeight: 40 } });

function fileIcon(mime: string, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf' || ext === 'pdf') return '📕';
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return '🗜️';
  if (/^(psd|ai|fig|sketch|xd|blend)$/.test(ext)) return '🎨';
  if (/^(lua|js|ts|py|rs|json|cs|cpp|c|java|go|rb|php|html|css)$/.test(ext)) return '🧾';
  if (/^(doc|docx|odt|txt|md|rtf)$/.test(ext)) return '📝';
  if (/^(xls|xlsx|csv|ods)$/.test(ext)) return '📊';
  if (/^(ppt|pptx|key|odp)$/.test(ext)) return '📽️';
  return '📎';
}

function createMediaNode(name: 'video' | 'audio' | 'fileBlock', tag: 'video' | 'audio' | null) {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return { src: dataAttr('src', ''), hash: dataAttr('hash'), name: dataAttr('name', ''), mime: dataAttr('mime', ''), size: dataAttr('size') };
    },
    parseHTML() {
      const rules: { tag: string; getAttrs?: (el: HTMLElement | string) => Record<string, unknown> | false }[] = [{ tag: `div[data-type="${name}"]` }];
      if (tag) rules.push({
        tag: `${tag}[src]`,
        getAttrs: el => { const src = (el as HTMLElement).getAttribute('src') ?? ''; return { src, name: decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() ?? '') }; },
      });
      return rules;
    },
    renderHTML({ node, HTMLAttributes }) {
      const attrs = mergeAttributes(HTMLAttributes, { 'data-type': name, class: `media-block media-${name}` });
      if (tag) return ['div', attrs, [tag, { src: node.attrs.src, controls: 'true', preload: 'metadata' }]];
      return ['div', attrs, ['a', { href: node.attrs.src, download: node.attrs.name }, `📎 ${node.attrs.name || 'Fichier'}`]];
    },
    addNodeView() {
      return ({ node }) => {
        let current = node;
        const dom = document.createElement('div');
        dom.className = `media-block media-${name}`; dom.contentEditable = 'false';
        let player: HTMLMediaElement | null = null;
        const caption = document.createElement('div'); caption.className = 'media-caption';
        const iconEl = document.createElement('span'); iconEl.className = 'file-icon';
        const nameEl = document.createElement('span'); nameEl.className = 'file-name';
        const sizeEl = document.createElement('span'); sizeEl.className = 'file-size';
        const openBtn = document.createElement('button'); openBtn.type = 'button'; openBtn.className = 'file-open'; openBtn.textContent = 'Ouvrir';
        openBtn.addEventListener('click', e => { e.preventDefault(); void openMedia(current.attrs); });
        if (tag) {
          player = document.createElement(tag);
          player.controls = true; player.preload = 'metadata';
          dom.appendChild(player);
          caption.append(nameEl, sizeEl, openBtn);
          dom.appendChild(caption);
        } else {
          dom.classList.add('file-card');
          dom.append(iconEl, nameEl, sizeEl, openBtn);
          dom.addEventListener('dblclick', () => void openMedia(current.attrs));
        }
        let token = 0;
        const render = (n: typeof node) => {
          nameEl.textContent = n.attrs.name || (tag ? '' : 'Fichier');
          sizeEl.textContent = formatBytes(n.attrs.size ?? undefined);
          iconEl.textContent = fileIcon(n.attrs.mime ?? '', n.attrs.name ?? '');
          if (player) {
            const t = ++token;
            void resolveMediaSrc(n.attrs).then(src => { if (t === token && player && player.getAttribute('src') !== src) player.src = src; });
          }
        };
        render(node);
        return {
          dom,
          update: n => { if (n.type !== current.type) return false; current = n; render(n); return true; },
          stopEvent: e => (player ? player.contains(e.target as globalThis.Node) : false) || openBtn.contains(e.target as globalThis.Node),
          ignoreMutation: () => true,
        };
      };
    },
  });
}

export const Video = createMediaNode('video', 'video');
export const Audio = createMediaNode('audio', 'audio');
export const FileBlock = createMediaNode('fileBlock', null);
