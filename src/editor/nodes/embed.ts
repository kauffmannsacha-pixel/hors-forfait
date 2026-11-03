// Bloc « embed » : iframe responsive (YouTube, Vimeo, Loom, Figma, Spotify, Google Docs, Maps, CodePen…).
import { Node, mergeAttributes } from '@tiptap/core';
import { isTauri } from '../../db/store';

export interface EmbedInfo { src: string; provider: string; label: string; ratio?: number; height?: number }

const YT_ID = /^[\w-]{11}$/;

/** Convertit une URL « publique » en URL intégrable. Fonction pure (testée). */
export function toEmbedUrl(raw: string): EmbedInfo | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.replace(/^www\.|^m\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  // YouTube
  if (host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    let id = '';
    if (host === 'youtu.be') id = parts[0] ?? '';
    else if (parts[0] === 'watch') id = url.searchParams.get('v') ?? '';
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? '';
    else id = url.searchParams.get('v') ?? '';
    if (YT_ID.test(id)) {
      const t = url.searchParams.get('t') ?? url.searchParams.get('start');
      const start = t ? parseTime(t) : 0;
      return { src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`, provider: 'youtube', label: 'YouTube', ratio: parts[0] === 'shorts' ? 9 / 16 : 16 / 9 };
    }
    const list = url.searchParams.get('list');
    if (list) return { src: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}`, provider: 'youtube', label: 'YouTube', ratio: 16 / 9 };
  }
  if (host === 'vimeo.com' && /^\d+$/.test(parts[0] ?? '')) return { src: `https://player.vimeo.com/video/${parts[0]}`, provider: 'vimeo', label: 'Vimeo', ratio: 16 / 9 };
  if (host === 'player.vimeo.com') return { src: url.href, provider: 'vimeo', label: 'Vimeo', ratio: 16 / 9 };
  if (host === 'loom.com' && (parts[0] === 'share' || parts[0] === 'embed') && parts[1]) return { src: `https://www.loom.com/embed/${parts[1]}`, provider: 'loom', label: 'Loom', ratio: 16 / 9 };
  if (host === 'figma.com' && ['file', 'design', 'proto', 'board'].includes(parts[0] ?? '')) return { src: `https://www.figma.com/embed?embed_host=prisme&url=${encodeURIComponent(url.href)}`, provider: 'figma', label: 'Figma', height: 450 };
  if (host === 'open.spotify.com' && parts.length >= 2) {
    const [kind, id] = parts[0] === 'embed' ? [parts[1], parts[2]] : [parts[0], parts[1]];
    if (kind && id) return { src: `https://open.spotify.com/embed/${kind}/${id}`, provider: 'spotify', label: 'Spotify', height: kind === 'track' || kind === 'episode' ? 152 : 352 };
  }
  if (host === 'codepen.io' && parts[1] === 'pen' && parts[2]) return { src: `https://codepen.io/${parts[0]}/embed/${parts[2]}?default-tab=result`, provider: 'codepen', label: 'CodePen', height: 400 };
  if (host === 'docs.google.com' && /^(document|spreadsheets|presentation|forms)$/.test(parts[0] ?? '')) {
    const base = url.href.replace(/\/(edit|view|preview|viewform)([?#].*)?$/, '');
    const suffix = parts[0] === 'forms' ? '/viewform?embedded=true' : parts[0] === 'presentation' ? '/embed' : '/preview';
    return { src: base + suffix, provider: 'google', label: 'Google Docs', height: parts[0] === 'presentation' ? undefined : 560, ratio: parts[0] === 'presentation' ? 16 / 9 : undefined };
  }
  if (host === 'drive.google.com' && parts[0] === 'file' && parts[2]) return { src: `https://drive.google.com/file/d/${parts[2]}/preview`, provider: 'google', label: 'Google Drive', height: 480 };
  if ((host === 'google.com' || host.startsWith('google.')) && parts[0] === 'maps') {
    const at = url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const place = parts[1] === 'place' && parts[2] ? decodeURIComponent(parts[2].replace(/\+/g, ' ')) : url.searchParams.get('q');
    const q = at ? `${at[1]},${at[2]}` : place ?? '';
    if (q) return { src: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=14&output=embed`, provider: 'maps', label: 'Google Maps', height: 400 };
  }
  if (host === 'canva.com' && parts[0] === 'design') return { src: url.href.split('?')[0] + '?embed', provider: 'canva', label: 'Canva', ratio: 16 / 9 };
  return { src: url.href, provider: 'web', label: host, height: 420 };
}

function parseTime(t: string): number {
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: { setEmbed: (url: string) => ReturnType };
  }
}

const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-presentation allow-forms allow-popups-to-escape-sandbox';
const ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';

export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const data = (name: string, def: unknown = null) => ({
      default: def,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-' + name) ?? def,
      renderHTML: (a: Record<string, unknown>) => (a[name] === null || a[name] === undefined ? {} : { ['data-' + name]: a[name] }),
    });
    return { src: data('src', ''), url: data('url', ''), provider: data('provider', 'web'), height: data('height'), ratio: data('ratio') };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="embed"]' },
      { tag: 'iframe[src]', getAttrs: el => { const src = (el as HTMLElement).getAttribute('src') ?? ''; const info = toEmbedUrl(src); return { src: info?.src ?? src, url: src, provider: info?.provider ?? 'web' }; } },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const h = node.attrs.height ? `height:${Number(node.attrs.height)}px` : 'aspect-ratio:16/9';
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'embed', class: 'embed' }),
      ['iframe', { src: node.attrs.src, loading: 'lazy', allowfullscreen: 'true', frameborder: '0', style: `width:100%;border:0;${h}` }]];
  },

  addCommands() {
    return {
      setEmbed: (url: string) => ({ commands }) => {
        const info = toEmbedUrl(url); if (!info) return false;
        return commands.insertContent({ type: this.name, attrs: { src: info.src, url, provider: info.provider, height: info.height ?? null, ratio: info.ratio ?? null } });
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'embed-block'; dom.dataset.provider = node.attrs.provider; dom.contentEditable = 'false';
      const frameWrap = document.createElement('div'); frameWrap.className = 'embed-frame';
      const iframe = document.createElement('iframe');
      iframe.loading = 'lazy'; iframe.setAttribute('allow', ALLOW); iframe.allowFullscreen = true;
      iframe.setAttribute('sandbox', SANDBOX); iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      frameWrap.appendChild(iframe);
      const bar = document.createElement('div'); bar.className = 'embed-bar';
      const label = document.createElement('span'); label.className = 'embed-label';
      const open = document.createElement('a'); open.className = 'embed-open'; open.textContent = 'Ouvrir ↗'; open.target = '_blank'; open.rel = 'noopener noreferrer';
      open.addEventListener('click', async e => {
        if (!isTauri) return;
        e.preventDefault();
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(current.attrs.url || current.attrs.src);
      });
      bar.append(label, open);
      const grip = document.createElement('div'); grip.className = 'embed-resize'; grip.title = 'Glisser pour changer la hauteur';
      dom.append(frameWrap, grip, bar);

      const render = (n: typeof node) => {
        if (iframe.getAttribute('src') !== n.attrs.src) iframe.src = n.attrs.src;
        const ratio = Number(n.attrs.ratio);
        if (n.attrs.height) { frameWrap.style.height = `${Number(n.attrs.height)}px`; frameWrap.style.aspectRatio = ''; }
        else { frameWrap.style.height = ''; frameWrap.style.aspectRatio = String(Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9); }
        let host = '';
        try { host = new URL(n.attrs.url || n.attrs.src).hostname.replace(/^www\./, ''); } catch { /* URL invalide */ }
        label.textContent = toEmbedUrl(n.attrs.url || n.attrs.src)?.label ?? host;
        open.href = n.attrs.url || n.attrs.src;
        dom.dataset.provider = n.attrs.provider;
      };
      render(node);

      grip.addEventListener('pointerdown', e => {
        if (!editor.isEditable) return;
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY; const startH = frameWrap.getBoundingClientRect().height;
        grip.setPointerCapture(e.pointerId); dom.classList.add('resizing');
        let h = startH;
        const move = (ev: PointerEvent) => { h = Math.max(120, Math.min(1400, startH + ev.clientY - startY)); frameWrap.style.height = `${h}px`; frameWrap.style.aspectRatio = ''; };
        const up = () => {
          grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
          dom.classList.remove('resizing');
          const pos = getPos(); if (typeof pos !== 'number') return;
          editor.chain().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...current.attrs, height: Math.round(h), ratio: null }); return true; }).run();
        };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
      });

      return {
        dom,
        update: n => { if (n.type !== current.type) return false; current = n; render(n); return true; },
        stopEvent: e => e.target === grip || bar.contains(e.target as globalThis.Node),
        ignoreMutation: () => true,
      };
    };
  },
});
