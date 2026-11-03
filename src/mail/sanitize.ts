// Lecture HTML sécurisée : DOMPurify (instance dédiée, aucun hook global) + blocage des contenus
// distants (images, CSS url(), srcset, background) tant que l'utilisateur ne les a pas autorisés.
// Le rendu se fait ensuite dans une iframe sandbox SANS scripts, avec une CSP stricte (2e barrière).
import DOMPurify from 'dompurify';
import { textToHtml } from './compose';

export interface SanitizeOptions {
  allowRemote: boolean;
  /** Images intégrées : Content-ID (minuscules, sans chevrons) → URL data:. */
  cid?: Record<string, string>;
}
export interface SanitizeResult {
  html: string;
  css: string;
  /** Contenus distants bloqués (images, fonds…). */
  blocked: number;
  /** Le message référence du contenu distant (même autorisé). */
  hasRemote: boolean;
  /** Fond défini sur <body> par l'expéditeur. */
  background?: string;
}

const FORBID_TAGS = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'option', 'textarea', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track', 'portal', 'noscript', 'template', 'svg', 'math', 'dialog'];
const FORBID_ATTR = ['srcdoc', 'formaction', 'action', 'ping', 'autofocus', 'contenteditable', 'draggable', 'tabindex', 'accesskey'];
const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const normCid = (c: string) => {
  let v = c.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '');
  try { v = decodeURIComponent(v); } catch { /* laisse tel quel */ }
  return v.toLowerCase();
};
const isRemote = (u: string) => /^(https?:)?\/\//i.test(u.trim());

/** Nettoie du CSS : @import, expression(), bindings retirés ; url() distantes neutralisées si bloquées. */
export function cleanCss(css: string, allowRemote: boolean, cid?: Record<string, string>): { css: string; remote: number } {
  let remote = 0;
  const out = css
    .replace(/<\/?\s*style/gi, '')
    .replace(/</g, '\\3c ')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'x-expr(')
    .replace(/(^|[;{\s])behavior\s*:/gi, '$1x-behavior:')
    .replace(/-moz-binding\s*:/gi, 'x-binding:')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q: string, u: string) => {
      const url = u.trim();
      if (/^data:image\//i.test(url) || /^data:font\//i.test(url) || /^data:application\/(x-)?font/i.test(url)) return m;
      if (/^cid:/i.test(url)) { const d = cid?.[normCid(url)]; return d ? `url("${d}")` : 'none'; }
      if (isRemote(url)) { remote++; return allowRemote ? `url("${url.replace(/"/g, '%22')}")` : 'none'; }
      return 'none';
    });
  return { css: out, remote };
}

/** Nettoie le HTML d'un e-mail pour affichage. */
export function sanitizeMailHtml(html: string, opts: SanitizeOptions): SanitizeResult {
  const parsed = new DOMParser().parseFromString(html || '', 'text/html');
  let blocked = 0; let hasRemote = false;

  // Feuilles de style de l'expéditeur (head + body) : extraites puis nettoyées.
  const cssParts: string[] = [];
  parsed.querySelectorAll('style').forEach(s => { cssParts.push(s.textContent ?? ''); s.remove(); });
  const cleaned = cleanCss(cssParts.join('\n'), opts.allowRemote, opts.cid);
  if (cleaned.remote) { hasRemote = true; if (!opts.allowRemote) blocked += cleaned.remote; }

  // Fond du <body> (bgcolor / style background-color)
  const body = parsed.body;
  const bg = body?.getAttribute('bgcolor') || /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)/i.exec(body?.getAttribute('style') ?? '')?.[1];

  const frag = DOMPurify.sanitize(body?.innerHTML ?? '', {
    FORBID_TAGS, FORBID_ATTR, RETURN_DOM_FRAGMENT: true, ALLOW_UNKNOWN_PROTOCOLS: false,
  }) as unknown as DocumentFragment;

  const walk = (root: ParentNode) => {
    root.querySelectorAll('*').forEach(el => {
      const tag = el.tagName.toLowerCase();
      // styles en ligne
      const st = el.getAttribute('style');
      if (st) {
        const c = cleanCss(st, opts.allowRemote, opts.cid);
        if (c.remote) { hasRemote = true; if (!opts.allowRemote) blocked += c.remote; }
        el.setAttribute('style', c.css);
      }
      // attribut background (tables)
      const bgAttr = el.getAttribute('background');
      if (bgAttr) {
        if (isRemote(bgAttr)) { hasRemote = true; if (!opts.allowRemote) { blocked++; el.removeAttribute('background'); } }
        else if (/^cid:/i.test(bgAttr)) { const d = opts.cid?.[normCid(bgAttr)]; if (d) el.setAttribute('background', d); else el.removeAttribute('background'); }
        else if (!/^data:image\//i.test(bgAttr)) el.removeAttribute('background');
      }
      if (tag === 'img') {
        const src = (el.getAttribute('src') ?? '').trim();
        if (el.hasAttribute('srcset')) { if (!opts.allowRemote) el.removeAttribute('srcset'); hasRemote = true; }
        if (/^cid:/i.test(src)) {
          const d = opts.cid?.[normCid(src)];
          if (d) el.setAttribute('src', d); else { el.setAttribute('src', TRANSPARENT_GIF); el.classList.add('prisme-missing'); }
        } else if (isRemote(src)) {
          hasRemote = true;
          const w = parseInt(el.getAttribute('width') ?? '', 10); const h = parseInt(el.getAttribute('height') ?? '', 10);
          const pixel = (w > 0 && w <= 3) || (h > 0 && h <= 3);
          if (!opts.allowRemote) {
            blocked++;
            if (pixel) { el.remove(); return; }
            el.setAttribute('data-prisme-src', src);
            el.setAttribute('src', TRANSPARENT_GIF);
            el.classList.add('prisme-blocked');
          } else if (pixel) { el.remove(); }
        } else if (!/^data:image\//i.test(src)) {
          el.removeAttribute('src');
        }
      }
      if (tag === 'a' || tag === 'area') {
        const href = (el.getAttribute('href') ?? '').trim();
        if (href && !/^(https?:|mailto:|tel:|#)/i.test(href)) el.removeAttribute('href');
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
  };
  walk(frag);
  const holder = document.createElement('div');
  holder.appendChild(frag);
  return { html: holder.innerHTML, css: cleaned.css, blocked, hasRemote, background: bg || undefined };
}

/** Texte brut → HTML nettoyé (mails sans partie HTML). */
export function sanitizePlainText(text: string): SanitizeResult {
  const html = DOMPurify.sanitize(`<div class="prisme-plain">${textToHtml(text)}</div>`, { FORBID_TAGS, FORBID_ATTR });
  return { html: String(html), css: '', blocked: 0, hasRemote: false };
}

export interface FrameOptions { allowRemote: boolean; dark: boolean; plain: boolean }

/** Document complet pour l'iframe sandbox (CSP : aucun script, aucun chargement distant sauf images autorisées). */
export function buildFrameDoc(s: SanitizeResult, o: FrameOptions): string {
  const remote = o.allowRemote ? ' https: http:' : '';
  const csp = `default-src 'none'; img-src data: blob:${remote}; style-src 'unsafe-inline'; font-src data:${o.allowRemote ? ' https:' : ''}; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  const darkText = o.dark && o.plain;
  const fg = darkText ? '#f5f5f7' : '#1d1d1f';
  const link = darkText ? '#4da3ff' : '#0a66d6';
  const base = `
html,body{margin:0;padding:0;background:transparent}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:${fg};overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;padding:2px 2px 6px}
img{max-width:100%;height:auto}
table{max-width:100%!important}
a{color:${link}}
pre{white-space:pre-wrap}
blockquote[type=cite],.gmail_quote blockquote{margin:6px 0 6px .6ex;border-left:2px solid ${darkText ? '#48484a' : '#c7c7cc'};padding-left:1ex;color:${darkText ? '#b0b0b5' : '#48484a'}}
.prisme-plain p{margin:0 0 .9em}
.prisme-blocked{background:${darkText ? '#2c2c2e' : '#f2f2f7'};outline:1px dashed #b0b0b5;outline-offset:-1px;min-width:18px;min-height:18px}
.prisme-missing{display:none}
${s.background ? `.prisme-root{background:${s.background}}` : ''}
`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${o.plain ? 'light dark' : 'light'}"><style>${base}</style><style>${s.css}</style></head><body><div class="prisme-root">${s.html}</div></body></html>`;
}
