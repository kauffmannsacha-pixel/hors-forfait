// Export de pages : Markdown, HTML autonome, PDF (impression) et archive .zip de tout l'espace.
import JSZip from 'jszip';
import { isTauri } from '../db/store';
import { allPages, childrenOf, displayTitle, getPage, isInTrash, usePages } from '../db/pages';
import type { Page } from '../db/types';
import { toast } from '../ui/appState';
import { docToMarkdown } from './markdown';
import { docToHTML } from './convert';
import { EXPORT_COLOR_VARS } from './colors';

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Sans titre';
const liveTitle = (id: string) => { const p = usePages.getState().pages[id]; return p ? displayTitle(p) : undefined; };

/** Enregistre un fichier : boîte de dialogue native (Tauri) ou téléchargement (navigateur). */
export async function saveFile(name: string, data: string | Uint8Array, mime: string, filter: { name: string; extensions: string[] }): Promise<boolean> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: name, filters: [filter], title: 'Exporter' });
    if (!path) return false;
    const fs = await import('@tauri-apps/plugin-fs');
    if (typeof data === 'string') await fs.writeTextFile(path, data); else await fs.writeFile(path, data);
    return true;
  }
  const blob = new Blob([typeof data === 'string' ? data : (data as BlobPart)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

export function pageToMarkdown(page: Page): string {
  const head = `# ${page.icon ? page.icon + ' ' : ''}${displayTitle(page)}\n\n`;
  return head + docToMarkdown(page.content, { pageTitle: liveTitle });
}

const EXPORT_CSS = `:root{${EXPORT_COLOR_VARS}}
*{box-sizing:border-box}body{margin:0;background:#fff;color:#1d1d1f;font:16px/1.65 Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:56px 24px 96px}
.cover{height:220px;border-radius:0 0 18px 18px;background-size:cover;background-position:center}
.icon{font-size:56px;line-height:1;margin-top:24px}
h1.page-title{font-size:2.5rem;letter-spacing:-.025em;line-height:1.1;margin:.3em 0 .6em}
h1{font-size:1.9rem;letter-spacing:-.02em}h2{font-size:1.45rem;letter-spacing:-.015em}h3{font-size:1.15rem}
a{color:#0a66c2}code{background:rgba(135,131,120,.15);border-radius:4px;padding:.1em .35em;font:.88em "SF Mono",ui-monospace,Menlo,Consolas,monospace;color:#eb5757}
pre{background:#f6f6f7;border-radius:10px;padding:14px 16px;overflow:auto}pre code{background:none;color:inherit;padding:0}
blockquote{border-left:3px solid currentColor;margin:0;padding:2px 0 2px 16px}
.callout{display:flex;gap:12px;padding:14px 16px;border-radius:10px;background:#f1f1ef;margin:8px 0}.callout-emoji{font-size:1.25em;line-height:1.4}
.callout[data-color=blue]{background:var(--bc-blue)}.callout[data-color=green]{background:var(--bc-green)}.callout[data-color=yellow]{background:var(--bc-yellow)}.callout[data-color=orange]{background:var(--bc-orange)}.callout[data-color=red]{background:var(--bc-red)}.callout[data-color=purple]{background:var(--bc-purple)}.callout[data-color=pink]{background:var(--bc-pink)}.callout[data-color=brown]{background:var(--bc-brown)}.callout[data-color=gray]{background:var(--bc-gray)}
.callout-content>:first-child{margin-top:0}.callout-content>:last-child{margin-bottom:0}
.columns{display:flex;gap:24px}.column{min-width:0}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #e3e3e1;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f7f7f5;font-weight:600}
ul[data-type=taskList]{list-style:none;padding-left:4px}ul[data-type=taskList] li{display:flex;gap:8px}ul[data-type=taskList] li[data-checked=true]>div{text-decoration:line-through;opacity:.6}
details{margin:6px 0}summary{cursor:pointer;font-weight:500}
img{max-width:100%;border-radius:8px}iframe{width:100%;border:0;border-radius:10px}
hr{border:0;border-top:1px solid #e3e3e1;margin:24px 0}mark{border-radius:3px;padding:0 2px}
.mention{color:#37352f;opacity:.85;font-weight:500}.media-block video,.media-block audio{width:100%}
.page-block{font-weight:500;text-decoration:underline;text-decoration-color:#ccc}
@media print{main{padding:0}}`;

async function inlineImages(html: string): Promise<string> {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const imgs = Array.from(tpl.content.querySelectorAll('img'));
  await Promise.all(imgs.map(async img => {
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:') || /^https?:\/\/(?!asset\.localhost)/.test(src)) return;
    try {
      const blob = await (await fetch(src)).blob();
      const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
      img.setAttribute('src', data);
    } catch { /* image locale illisible : on garde le lien */ }
  }));
  return tpl.innerHTML;
}

const coverCss = (cover?: string) => {
  if (!cover) return '';
  if (cover.startsWith('gradient:')) return `background:${COVER_GRADIENTS[Number(cover.slice(9)) % COVER_GRADIENTS.length]}`;
  return `background-image:url('${cover.replace(/'/g, '%27')}')`;
};
export const COVER_GRADIENTS = [
  'linear-gradient(135deg,#ff9a9e 0%,#fad0c4 45%,#a18cd1 100%)',
  'linear-gradient(135deg,#a1c4fd 0%,#c2e9fb 100%)',
  'linear-gradient(135deg,#84fab0 0%,#8fd3f4 100%)',
  'linear-gradient(135deg,#fccb90 0%,#d57eeb 100%)',
  'linear-gradient(135deg,#e0c3fc 0%,#8ec5fc 100%)',
  'linear-gradient(135deg,#f6d365 0%,#fda085 100%)',
  'linear-gradient(135deg,#43e97b 0%,#38f9d7 100%)',
  'linear-gradient(135deg,#30cfd0 0%,#330867 100%)',
  'linear-gradient(135deg,#5ee7df 0%,#b490ca 100%)',
  'linear-gradient(160deg,#0f2027 0%,#203a43 50%,#2c5364 100%)',
];

export async function pageToHTML(page: Page): Promise<string> {
  const body = await inlineImages(docToHTML(page.content));
  const title = displayTitle(page).replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.18.10/dist/katex.min.css">
<style>${EXPORT_CSS}</style></head>
<body>${page.cover ? `<div class="cover" style="${coverCss(page.cover)}"></div>` : ''}<main>
${page.icon ? `<div class="icon">${page.icon}</div>` : ''}<h1 class="page-title">${title}</h1>
${body}
</main></body></html>`;
}

/** Imprime la page courante (→ « Enregistrer au format PDF »). La CSS @media print isole le contenu. */
export function printCurrentPage() {
  const root = document.documentElement;
  root.classList.add('print-page');
  const done = () => { root.classList.remove('print-page'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1000); }, 60);
}

export async function exportPage(id: string, format: 'md' | 'html' | 'pdf') {
  const page = getPage(id);
  if (!page) { toast('Page introuvable.', 'error'); return; }
  try {
    const name = safeFileName(displayTitle(page));
    if (format === 'pdf') { printCurrentPage(); return; }
    const ok = format === 'md'
      ? await saveFile(`${name}.md`, pageToMarkdown(page), 'text/markdown', { name: 'Markdown', extensions: ['md'] })
      : await saveFile(`${name}.html`, await pageToHTML(page), 'text/html', { name: 'Page web', extensions: ['html'] });
    if (ok) toast(`Export ${format === 'md' ? 'Markdown' : 'HTML'} terminé`, 'success');
  } catch (e) {
    toast(`Export impossible : ${(e as Error).message}`, 'error');
  }
}

/** Archive .zip Markdown de tout l'espace (arborescence de dossiers). */
export async function exportWorkspace() {
  try {
    const zip = new JSZip();
    const used = new Map<string, number>();
    const unique = (dir: string, base: string) => { const k = `${dir}/${base}`.toLowerCase(); const n = used.get(k) ?? 0; used.set(k, n + 1); return n ? `${base} (${n + 1})` : base; };
    const walk = (parentId: string | null, dir: string) => {
      for (const p of childrenOf(parentId)) {
        const base = unique(dir, safeFileName(displayTitle(p)));
        zip.file(`${dir ? dir + '/' : ''}${base}.md`, pageToMarkdown(p));
        if (allPages().some(c => c.parentId === p.id && !c.trashed)) walk(p.id, `${dir ? dir + '/' : ''}${base}`);
      }
    };
    walk(null, '');
    const count = allPages().filter(p => !isInTrash(p.id)).length;
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const ok = await saveFile(`Prisme — export ${new Date().toISOString().slice(0, 10)}.zip`, bytes, 'application/zip', { name: 'Archive zip', extensions: ['zip'] });
    if (ok) toast(`${count} pages exportées`, 'success');
  } catch (e) { toast(`Export impossible : ${(e as Error).message}`, 'error'); }
}
