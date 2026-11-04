// Export PNG d'un graphique : SVG cloné avec styles calculés en ligne (les variables CSS sont résolues),
// dessiné sur un canvas haute résolution avec un en-tête (titre + source).

const STYLE_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'visibility', 'display',
];

/** Clone le SVG en recopiant les styles calculés de chaque élément (indépendant de la feuille de style). */
export function inlineSvg(src: SVGSVGElement): SVGSVGElement {
  const clone = src.cloneNode(true) as SVGSVGElement;
  const a = [src, ...Array.from(src.querySelectorAll('*'))];
  const b = [clone, ...Array.from(clone.querySelectorAll('*'))];
  a.forEach((el, i) => {
    const target = b[i] as SVGElement | undefined;
    if (!target || !(el instanceof Element)) return;
    const cs = getComputedStyle(el);
    const decl = STYLE_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).filter(d => !d.endsWith(':')).join(';');
    target.setAttribute('style', decl);
    target.removeAttribute('class');
  });
  const { width, height } = src.getBoundingClientRect();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(width)));
  clone.setAttribute('height', String(Math.round(height)));
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`);
  return clone;
}

function cssVar(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Rend le SVG en PNG (×2) avec fond opaque, titre et ligne de source. */
export async function svgToPng(svg: SVGSVGElement, opts: { title: string; subtitle?: string; scale?: number }): Promise<Blob> {
  const scale = opts.scale ?? 2;
  const clone = inlineSvg(svg);
  const w = Number(clone.getAttribute('width')), h = Number(clone.getAttribute('height'));
  const bg = cssVar(svg, '--bg2', '#ffffff');
  const fg = cssVar(svg, '--fg', '#1d1d1f');
  const muted = cssVar(svg, '--muted', '#6e6e73');
  const font = getComputedStyle(svg).fontFamily || 'system-ui, sans-serif';
  const head = 64, foot = 28, pad = 24;
  const data = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.decoding = 'async';
  const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Export PNG impossible : rendu du graphique refusé par le navigateur.')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((w + pad * 2) * scale);
    canvas.height = Math.round((h + head + foot) * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Export PNG impossible : canvas indisponible.');
    ctx.scale(scale, scale);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w + pad * 2, h + head + foot);
    ctx.fillStyle = fg;
    ctx.font = `600 17px ${font}`;
    ctx.fillText(opts.title, pad, 30);
    if (opts.subtitle) { ctx.fillStyle = muted; ctx.font = `400 12px ${font}`; ctx.fillText(opts.subtitle, pad, 50); }
    ctx.drawImage(img, pad, head, w, h);
    ctx.fillStyle = muted;
    ctx.font = `400 11px ${font}`;
    ctx.fillText(`Prisme · ${new Date().toLocaleString('fr-FR')}`, pad, head + h + 18);
    return await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Export PNG impossible.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
