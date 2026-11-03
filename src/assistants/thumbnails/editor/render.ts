// Rendu Canvas 2D du document (coordonnées 1280×720) : images recadrées, texte (contour épais, ombre, glow),
// flèches et cercles avec liseré. Utilisé par l'éditeur (affichage) et l'export.
import { CANVAS_H, CANVAS_W, center, corners, type ArrowLayer, type CircleLayer, type EditorDoc, type ImageLayer, type ImageSrc, type Layer, type Measure, type TextLayer } from './model';

export type Drawable = CanvasImageSource & { width: number; height: number };
export const srcKey = (s: ImageSrc) => (s.kind === 'vault' ? `vault:${s.hash}` : `mem:${s.key}`);

const quoteFont = (f: string) => (/^[\w-]+$/.test(f) ? f : `"${f.replace(/"/g, '')}"`);
export const fontString = (l: Pick<TextLayer, 'weight' | 'size' | 'font'>) => `${l.weight} ${Math.max(1, l.size)}px ${quoteFont(l.font)}, "Arial Black", Impact, system-ui, sans-serif`;
const linesOf = (l: TextLayer) => (l.uppercase ? l.text.toLocaleUpperCase('fr-FR') : l.text).split('\n');

type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };
/** Couleur hex + opacité → rgba() (les autres notations sont rendues telles quelles). */
export function withAlpha(c: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
function applyFont(ctx: Ctx, l: TextLayer) {
  ctx.font = fontString(l);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${l.letterSpacing}px`;
}
let measureCtx: Ctx | null = null;
/** Mesure (largeur max des lignes × hauteur du bloc) avec un canvas hors écran. */
export const measureText: Measure = (l) => {
  if (!measureCtx) { const c = document.createElement('canvas'); measureCtx = c.getContext('2d') as Ctx | null; }
  const lines = linesOf(l);
  if (!measureCtx) return { w: l.size * 0.6 * Math.max(...lines.map(s => s.length)), h: l.size * l.lineHeight * lines.length };
  applyFont(measureCtx, l);
  return { w: Math.max(1, ...lines.map(s => measureCtx!.measureText(s).width)), h: l.size * l.lineHeight * lines.length };
};

function drawTextLayer(ctx: Ctx, l: TextLayer) {
  const lines = linesOf(l); const { w, h } = measureText(l);
  const lh = l.size * l.lineHeight;
  ctx.save();
  ctx.translate(l.x, l.y); ctx.rotate((l.rotation * Math.PI) / 180); ctx.globalAlpha = l.opacity;
  applyFont(ctx, l);
  ctx.textBaseline = 'middle'; ctx.textAlign = l.align;
  ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  const ax = l.align === 'left' ? -w / 2 : l.align === 'right' ? w / 2 : 0;
  const each = (fn: (s: string, x: number, y: number) => void) => lines.forEach((s, i) => fn(s, ax, -h / 2 + lh * (i + 0.5)));
  const strokeW = l.stroke.enabled ? l.stroke.width * 2 : 0;
  const pass = (withStroke: boolean) => {
    if (withStroke && strokeW > 0) { ctx.lineWidth = strokeW; ctx.strokeStyle = l.stroke.color; each((s, x, y) => ctx.strokeText(s, x, y)); }
    ctx.fillStyle = l.color; each((s, x, y) => ctx.fillText(s, x, y));
  };
  if (l.glow.enabled && l.glow.blur > 0) {
    ctx.save(); ctx.shadowColor = l.glow.color; ctx.shadowBlur = l.glow.blur; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    for (let i = 0; i < Math.max(1, Math.min(5, Math.round(l.glow.strength))); i++) {
      if (strokeW > 0) { ctx.lineWidth = strokeW; ctx.strokeStyle = l.glow.color; each((s, x, y) => ctx.strokeText(s, x, y)); }
      else { ctx.fillStyle = l.glow.color; each((s, x, y) => ctx.fillText(s, x, y)); }
    }
    ctx.restore();
  }
  if (l.shadow.enabled) {
    ctx.save(); ctx.shadowColor = withAlpha(l.shadow.color, l.shadow.opacity ?? 0.6); ctx.shadowBlur = l.shadow.blur; ctx.shadowOffsetX = l.shadow.dx; ctx.shadowOffsetY = l.shadow.dy;
    pass(true); ctx.restore();
  }
  pass(true);
  ctx.restore();
}

function arrowPath(ctx: CanvasRenderingContext2D, l: ArrowLayer) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1, len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const headL = Math.min(len * 0.6, l.head * 1.35), hw = Math.max(l.head, l.width * 0.9), sw = l.width / 2;
  const bx = l.x2 - ux * headL, by = l.y2 - uy * headL;
  ctx.beginPath();
  ctx.moveTo(l.x1 + nx * sw, l.y1 + ny * sw);
  ctx.lineTo(bx + nx * sw, by + ny * sw);
  ctx.lineTo(bx + nx * hw, by + ny * hw);
  ctx.lineTo(l.x2, l.y2);
  ctx.lineTo(bx - nx * hw, by - ny * hw);
  ctx.lineTo(bx - nx * sw, by - ny * sw);
  ctx.lineTo(l.x1 - nx * sw, l.y1 - ny * sw);
  ctx.closePath();
}
function drawArrow(ctx: CanvasRenderingContext2D, l: ArrowLayer) {
  ctx.save(); ctx.globalAlpha = l.opacity; ctx.lineJoin = 'round';
  if (l.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6; }
  arrowPath(ctx, l);
  if (l.outline.enabled && l.outline.width > 0) { ctx.lineWidth = l.outline.width * 2; ctx.strokeStyle = l.outline.color; ctx.stroke(); ctx.shadowColor = 'transparent'; }
  ctx.fillStyle = l.color; ctx.fill();
  ctx.restore();
}
function drawCircle(ctx: CanvasRenderingContext2D, l: CircleLayer) {
  ctx.save(); ctx.globalAlpha = l.opacity;
  ctx.translate(l.x, l.y); ctx.rotate((l.rotation * Math.PI) / 180);
  if (l.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 5; }
  ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1, l.rx), Math.max(1, l.ry), 0, 0, Math.PI * 2);
  if (l.outline.enabled && l.outline.width > 0) { ctx.lineWidth = l.width + l.outline.width * 2; ctx.strokeStyle = l.outline.color; ctx.stroke(); ctx.shadowColor = 'transparent'; }
  ctx.lineWidth = l.width; ctx.strokeStyle = l.color; ctx.stroke();
  ctx.restore();
}
function drawImageLayer(ctx: CanvasRenderingContext2D, l: ImageLayer, img: Drawable | undefined) {
  const w = l.crop.w * l.scale, h = l.crop.h * l.scale;
  ctx.save(); ctx.globalAlpha = l.opacity;
  ctx.translate(l.x, l.y); ctx.rotate((l.rotation * Math.PI) / 180); if (l.flipX) ctx.scale(-1, 1);
  if (img) {
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, l.crop.x, l.crop.y, l.crop.w, l.crop.h, -w / 2, -h / 2, w, h);
  } else {
    ctx.fillStyle = 'rgba(128,128,128,0.25)'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(128,128,128,0.8)'; ctx.setLineDash([12, 10]); ctx.lineWidth = 3; ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.setLineDash([]); ctx.fillStyle = 'rgba(200,200,200,0.9)'; ctx.font = '600 28px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Image en chargement ou introuvable', 0, 0);
  }
  ctx.restore();
}

export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, images: Map<string, Drawable>) {
  if (!l.visible) return;
  if (l.type === 'image') drawImageLayer(ctx, l, images.get(srcKey(l.src)));
  else if (l.type === 'text') drawTextLayer(ctx as Ctx, l);
  else if (l.type === 'arrow') drawArrow(ctx, l);
  else drawCircle(ctx, l);
}
/** Dessine le document (l'appelant fixe la transformation d'échelle). */
export function renderDoc(ctx: CanvasRenderingContext2D, doc: EditorDoc, images: Map<string, Drawable>) {
  ctx.save();
  ctx.fillStyle = doc.background; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  for (const l of doc.layers) drawLayer(ctx, l, images);
  ctx.restore();
}

/** Surcouche de sélection (cadre, poignées), épaisseurs exprimées en pixels écran via `px`. */
export function drawSelection(ctx: CanvasRenderingContext2D, l: Layer, px: number, accent: string, cropping = false) {
  ctx.save();
  ctx.lineWidth = 1.5 * px; ctx.strokeStyle = accent; ctx.setLineDash(cropping ? [6 * px, 4 * px] : []);
  if (l.type === 'arrow') {
    ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.setLineDash([5 * px, 4 * px]); ctx.stroke(); ctx.setLineDash([]);
    for (const [x, y] of [[l.x1, l.y1], [l.x2, l.y2]]) { ctx.beginPath(); ctx.arc(x, y, 7 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
  } else {
    const pts = corners(l, measureText);
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    for (const p of pts) { ctx.beginPath(); ctx.rect(p.x - 6 * px, p.y - 6 * px, 12 * px, 12 * px); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
    const c = center(l); ctx.beginPath(); ctx.arc(c.x, c.y, 3 * px, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill();
  }
  ctx.restore();
}
/** Repères : tiers + zone de la durée (coin bas-droit) masquée dans le fil. */
export function drawGuides(ctx: CanvasRenderingContext2D, px: number) {
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = px; ctx.setLineDash([6 * px, 6 * px]);
  for (const t of [1 / 3, 2 / 3]) {
    ctx.beginPath(); ctx.moveTo(CANVAS_W * t, 0); ctx.lineTo(CANVAS_W * t, CANVAS_H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, CANVAS_H * t); ctx.lineTo(CANVAS_W, CANVAS_H * t); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const bw = 150, bh = 62; ctx.fillRect(CANVAS_W - bw - 14, CANVAS_H - bh - 14, bw, bh);
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = `600 ${30}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('12:34', CANVAS_W - bw / 2 - 14, CANVAS_H - bh / 2 - 14);
  ctx.restore();
}
