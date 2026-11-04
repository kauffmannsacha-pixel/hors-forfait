// Croquis schématique SVG d'un concept de miniature (16:9). Chaîne pure, valeurs échappées / validées.
import { isHexColor, hexToRgb, readableOn } from './color';
import type { Concept, Emotion, SketchItem } from './types';

const W = 160, H = 90;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const col = (c: string | undefined, d: string) => (c && isHexColor(c) ? c : d);
const f = (n: number) => (Math.round(n * 100) / 100).toString();

function face(cx: number, cy: number, rx: number, ry: number, emotion: Emotion | undefined, skin = '#f2cfb3'): string {
  const e = emotion ?? 'neutre';
  const big = e === 'surprise' || e === 'peur';
  const ex = rx * 0.36, ey = cy - ry * 0.12, er = Math.max(0.6, rx * (big ? 0.13 : 0.09));
  const browY = ey - ry * (big ? 0.3 : 0.2);
  const brow = (side: -1 | 1) => {
    const x0 = cx + side * ex - rx * 0.16, x1 = cx + side * ex + rx * 0.16;
    const inner = side === -1 ? x1 : x0, outer = side === -1 ? x0 : x1;
    const dyInner = e === 'colère' ? ry * 0.1 : e === 'tristesse' || e === 'peur' ? -ry * 0.08 : e === 'curiosité' && side === 1 ? -ry * 0.1 : 0;
    return `<line x1="${f(outer)}" y1="${f(browY)}" x2="${f(inner)}" y2="${f(browY + dyInner)}" stroke="#2b1d16" stroke-width="${f(Math.max(0.6, rx * 0.07))}" stroke-linecap="round"/>`;
  };
  const my = cy + ry * 0.42, mw = rx * 0.42;
  let mouth: string;
  if (big) mouth = `<ellipse cx="${f(cx)}" cy="${f(my)}" rx="${f(mw * 0.55)}" ry="${f(ry * 0.2)}" fill="#3b0f0f"/>`;
  else if (e === 'joie') mouth = `<path d="M${f(cx - mw)} ${f(my - ry * 0.05)} Q${f(cx)} ${f(my + ry * 0.3)} ${f(cx + mw)} ${f(my - ry * 0.05)} Z" fill="#3b0f0f"/>`;
  else if (e === 'tristesse') mouth = `<path d="M${f(cx - mw)} ${f(my + ry * 0.08)} Q${f(cx)} ${f(my - ry * 0.16)} ${f(cx + mw)} ${f(my + ry * 0.08)}" fill="none" stroke="#3b0f0f" stroke-width="${f(rx * 0.08)}" stroke-linecap="round"/>`;
  else if (e === 'dégoût') mouth = `<path d="M${f(cx - mw)} ${f(my)} q${f(mw / 2)} ${f(-ry * 0.1)} ${f(mw)} 0 t${f(mw)} 0" fill="none" stroke="#3b0f0f" stroke-width="${f(rx * 0.08)}" stroke-linecap="round"/>`;
  else if (e === 'colère') mouth = `<path d="M${f(cx - mw)} ${f(my + ry * 0.05)} L${f(cx + mw)} ${f(my + ry * 0.05)}" stroke="#3b0f0f" stroke-width="${f(rx * 0.12)}" stroke-linecap="round"/>`;
  else if (e === 'curiosité') mouth = `<path d="M${f(cx - mw * 0.7)} ${f(my + ry * 0.04)} L${f(cx + mw * 0.6)} ${f(my - ry * 0.04)}" stroke="#3b0f0f" stroke-width="${f(rx * 0.08)}" stroke-linecap="round"/>`;
  else mouth = `<path d="M${f(cx - mw * 0.8)} ${f(my)} L${f(cx + mw * 0.8)} ${f(my)}" stroke="#3b0f0f" stroke-width="${f(rx * 0.08)}" stroke-linecap="round"/>`;
  const eye = (side: -1 | 1) => big
    ? `<circle cx="${f(cx + side * ex)}" cy="${f(ey)}" r="${f(er)}" fill="#fff" stroke="#2b1d16" stroke-width="${f(rx * 0.03)}"/><circle cx="${f(cx + side * ex)}" cy="${f(ey)}" r="${f(er * 0.45)}" fill="#1b120d"/>`
    : `<ellipse cx="${f(cx + side * ex)}" cy="${f(ey)}" rx="${f(er)}" ry="${f(er * 1.15)}" fill="#1b120d"/>`;
  return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${skin}" stroke="#2b1d16" stroke-width="${f(Math.max(0.5, rx * 0.04))}"/>${eye(-1)}${eye(1)}${brow(-1)}${brow(1)}${mouth}`;
}
function arrow(x1: number, y1: number, x2: number, y2: number, color: string): string {
  const dx = x2 - x1, dy = y2 - y1, len = Math.max(1, Math.hypot(dx, dy)), ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const sw = 2.2, hw = 5.5, hl = Math.min(len * 0.5, 8), bx = x2 - ux * hl, by = y2 - uy * hl;
  const pts = [[x1 + nx * sw, y1 + ny * sw], [bx + nx * sw, by + ny * sw], [bx + nx * hw, by + ny * hw], [x2, y2], [bx - nx * hw, by - ny * hw], [bx - nx * sw, by - ny * sw], [x1 - nx * sw, y1 - ny * sw]];
  return `<polygon points="${pts.map(p => p.map(f).join(',')).join(' ')}" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>`;
}
const caption = (x: number, y: number, s: string) => `<text x="${f(x)}" y="${f(y)}" font-size="4.2" font-family="system-ui, sans-serif" font-weight="600" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="0.9" paint-order="stroke">${esc(s.slice(0, 28))}</text>`;

function item(it: SketchItem, c: Concept): string {
  const x = it.x * W, y = it.y * H, w = Math.max(2, it.w * W), h = Math.max(2, it.h * H), cx = x + w / 2, cy = y + h / 2;
  switch (it.kind) {
    case 'fond': return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${col(it.color, c.colors[0] ?? '#222')}"/>`;
    case 'split': {
      const sx = Math.min(W * 0.7, Math.max(W * 0.3, cx));
      return `<rect x="0" y="0" width="${f(sx)}" height="${H}" fill="${col(it.color, c.colors[0] ?? '#1d3557')}"/><rect x="${f(sx)}" y="0" width="${f(W - sx)}" height="${H}" fill="${col(c.colors[1], '#e63946')}"/><path d="M${f(sx - 3)} 0 L${f(sx + 3)} ${H * 0.4} L${f(sx - 2)} ${H * 0.55} L${f(sx + 2)} ${H}" fill="none" stroke="#fff" stroke-width="1.6"/>`;
    }
    case 'halo': return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(w / 2)}" ry="${f(h / 2)}" fill="url(#halo-${esc(c.id)})"/>`;
    case 'visage': return face(cx, cy, w / 2, h / 2, it.emotion) + (it.label ? caption(cx, Math.min(H - 2, y + h + 5), it.label) : '');
    case 'personne': {
      const hr = Math.min(w * 0.32, h * 0.26), hy = y + hr + 1;
      const body = `<path d="M${f(x + w * 0.08)} ${f(y + h)} Q${f(x + w * 0.1)} ${f(hy + hr * 1.3)} ${f(cx)} ${f(hy + hr * 1.15)} Q${f(x + w * 0.9)} ${f(hy + hr * 1.3)} ${f(x + w * 0.92)} ${f(y + h)} Z" fill="${col(it.color, '#3a3a48')}" stroke="#111" stroke-width="0.6"/>`;
      return body + face(cx, hy, hr * 0.85, hr, it.emotion) + (it.label ? caption(cx, Math.min(H - 2, y + h - 2), it.label) : '');
    }
    case 'objet': {
      const fill = col(it.color, c.colors[1] ?? '#ffd60a');
      return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(Math.min(w, h) * 0.18)}" fill="${fill}" stroke="#111" stroke-width="0.7"/>` + (it.label ? `<text x="${f(cx)}" y="${f(cy + 1.5)}" font-size="${f(Math.min(5, h * 0.3))}" font-family="system-ui, sans-serif" font-weight="700" text-anchor="middle" fill="${readableOn(hexToRgb(fill))}">${esc(it.label.slice(0, 24))}</text>` : '');
    }
    case 'texte': {
      const t = (it.label || c.text || 'TEXTE').toLocaleUpperCase('fr-FR');
      const size = Math.max(4, Math.min(h * 0.85, w / Math.max(1, t.length * 0.56)));
      return `<text x="${f(cx)}" y="${f(cy + size * 0.35)}" font-size="${f(size)}" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" text-anchor="middle" fill="${col(it.color, c.textColor)}" stroke="${col(c.textStroke, '#000')}" stroke-width="${f(size * 0.16)}" stroke-linejoin="round" paint-order="stroke">${esc(t)}</text>`;
    }
    case 'fleche': return arrow(x, y, x + it.w * W, y + it.h * H, col(it.color, '#ff2d2d'));
    case 'cercle': return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(w / 2)}" ry="${f(h / 2)}" fill="none" stroke="#fff" stroke-width="3.2"/><ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(w / 2)}" ry="${f(h / 2)}" fill="none" stroke="${col(it.color, '#ff2d2d')}" stroke-width="2"/>`;
  }
}

/** SVG complet (viewBox 160×90) : fond, éléments dans l'ordre, repères des tiers et zone de durée. */
export function sketchSvg(c: Concept, opts: { guides?: boolean; exclude?: SketchItem['kind'][] } = {}): string {
  const order: SketchItem['kind'][] = ['fond', 'split', 'halo', 'personne', 'objet', 'visage', 'cercle', 'fleche', 'texte'];
  const ex = new Set(opts.exclude ?? []);
  const items = [...c.sketch].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (c.text && !items.some(i => i.kind === 'texte')) items.push({ kind: 'texte', x: 0.04, y: 0.06, w: 0.5, h: 0.24, label: c.text });
  for (let i = items.length - 1; i >= 0; i--) if (ex.has(items[i].kind)) items.splice(i, 1);
  const halo = col(c.colors[2] ?? c.colors[1], '#ffffff');
  const guides = opts.guides !== false
    ? `<g stroke="rgba(255,255,255,.28)" stroke-width=".35" stroke-dasharray="1.6 1.6"><line x1="${W / 3}" y1="0" x2="${W / 3}" y2="${H}"/><line x1="${(2 * W) / 3}" y1="0" x2="${(2 * W) / 3}" y2="${H}"/><line x1="0" y1="${H / 3}" x2="${W}" y2="${H / 3}"/><line x1="0" y1="${(2 * H) / 3}" x2="${W}" y2="${(2 * H) / 3}"/></g><rect x="${W - 21}" y="${H - 10}" width="18" height="7" rx="1.2" fill="rgba(0,0,0,.72)"/><text x="${W - 12}" y="${H - 5}" font-size="4.3" font-family="system-ui, sans-serif" font-weight="600" text-anchor="middle" fill="#fff">12:34</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 8}" height="${H * 8}"><defs><radialGradient id="halo-${esc(c.id)}"><stop offset="0" stop-color="${halo}" stop-opacity=".85"/><stop offset="1" stop-color="${halo}" stop-opacity="0"/></radialGradient><clipPath id="clip-${esc(c.id)}"><rect width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#clip-${esc(c.id)})"><rect width="${W}" height="${H}" fill="${col(c.colors[0], '#202024')}"/>${items.map(i => item(i, c)).join('')}${guides}</g></svg>`;
}
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
