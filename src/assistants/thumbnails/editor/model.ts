// Modèle (pur) de l'éditeur de miniature 1280×720 : calques, géométrie, élastique aux bords, historique.
import { crop169, type Rect } from '../lib/raster';

export const CANVAS_W = 1280, CANVAS_H = 720;
export type { Rect };

interface Base { id: string; name: string; visible: boolean; locked: boolean; opacity: number; rotation: number /* degrés */ }
export type ImageSrc = { kind: 'vault'; hash: string; name: string } | { kind: 'memory'; key: string; name: string };
export interface ImageLayer extends Base { type: 'image'; src: ImageSrc; natW: number; natH: number; crop: Rect; x: number; y: number; scale: number; flipX: boolean }
export interface TextStyle {
  font: string; size: number; weight: number; color: string; uppercase: boolean; align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number;
  stroke: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; opacity: number; blur: number; dx: number; dy: number };
  glow: { enabled: boolean; color: string; blur: number; strength: number };
}
export interface TextLayer extends Base, TextStyle { type: 'text'; text: string; x: number; y: number }
export interface Outline { enabled: boolean; color: string; width: number }
export interface ArrowLayer extends Base { type: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number; head: number; outline: Outline; shadow: boolean }
export interface CircleLayer extends Base { type: 'circle'; x: number; y: number; rx: number; ry: number; color: string; width: number; outline: Outline; shadow: boolean }
export type Layer = ImageLayer | TextLayer | ArrowLayer | CircleLayer;
export interface EditorDoc { version: 1; background: string; layers: Layer[] /* du fond vers le dessus */ }

export const FONTS = ['Impact', 'Arial Black', 'Bahnschrift', 'Segoe UI', 'Inter', 'Montserrat', 'Trebuchet MS', 'Verdana', 'Georgia', 'Comic Sans MS', 'Courier New'];
export const newId = () => Math.random().toString(36).slice(2, 10);
export const emptyDoc = (): EditorDoc => ({ version: 1, background: '#101014', layers: [] });

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'Impact', size: 150, weight: 900, color: '#ffffff', uppercase: true, align: 'center', lineHeight: 1.02, letterSpacing: 0,
  stroke: { enabled: true, color: '#000000', width: 14 },
  shadow: { enabled: true, color: '#000000', opacity: 0.6, blur: 24, dx: 0, dy: 10 },
  glow: { enabled: false, color: '#ffd60a', blur: 40, strength: 2 },
};
export function makeText(text = 'TEXTE', patch: Partial<TextLayer> = {}): TextLayer {
  return { id: newId(), type: 'text', name: 'Texte', visible: true, locked: false, opacity: 1, rotation: 0, text, x: CANVAS_W / 2, y: CANVAS_H * 0.25, ...DEFAULT_TEXT_STYLE, ...patch };
}
export function makeArrow(patch: Partial<ArrowLayer> = {}): ArrowLayer {
  return { id: newId(), type: 'arrow', name: 'Flèche', visible: true, locked: false, opacity: 1, rotation: 0, x1: 470, y1: 250, x2: 760, y2: 450, color: '#ff2d2d', width: 34, head: 46, outline: { enabled: true, color: '#ffffff', width: 7 }, shadow: true, ...patch };
}
export function makeCircle(patch: Partial<CircleLayer> = {}): CircleLayer {
  return { id: newId(), type: 'circle', name: 'Cercle', visible: true, locked: false, opacity: 1, rotation: 0, x: CANVAS_W / 2, y: CANVAS_H / 2, rx: 170, ry: 170, color: '#ff2d2d', width: 18, outline: { enabled: true, color: '#ffffff', width: 6 }, shadow: true, ...patch };
}
/** Placement « remplir le cadre » : recadrage 16:9 centré, mis à l'échelle sur 1280×720. */
export function coverPlacement(natW: number, natH: number) { const crop = crop169(natW, natH); return { crop, x: CANVAS_W / 2, y: CANVAS_H / 2, scale: CANVAS_W / crop.w }; }
/** Placement « ajuster » : image entière contenue dans le cadre. */
export function containPlacement(natW: number, natH: number) { return { crop: { x: 0, y: 0, w: natW, h: natH }, x: CANVAS_W / 2, y: CANVAS_H / 2, scale: Math.min(CANVAS_W / natW, CANVAS_H / natH) }; }
export function makeImage(src: ImageSrc, natW: number, natH: number, mode: 'cover' | 'contain' = 'cover', patch: Partial<ImageLayer> = {}): ImageLayer {
  const p = mode === 'cover' ? coverPlacement(natW, natH) : containPlacement(natW, natH);
  return { id: newId(), type: 'image', name: src.name || 'Image', visible: true, locked: false, opacity: 1, rotation: 0, src, natW, natH, flipX: false, ...p, ...patch };
}

// ── Géométrie ──────────────────────────────────────────────────────────────
export interface Pt { x: number; y: number }
export type Measure = (l: TextLayer) => { w: number; h: number };
export function center(l: Layer): Pt { return l.type === 'arrow' ? { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 } : { x: l.x, y: l.y }; }
/** Taille locale (non tournée) du calque. */
export function localSize(l: Layer, measure: Measure): { w: number; h: number } {
  switch (l.type) {
    case 'image': return { w: l.crop.w * l.scale, h: l.crop.h * l.scale };
    case 'text': { const m = measure(l); const pad = (l.stroke.enabled ? l.stroke.width : 0) * 2; return { w: m.w + pad, h: m.h + pad }; }
    case 'circle': { const pad = l.width + (l.outline.enabled ? l.outline.width * 2 : 0); return { w: 2 * l.rx + pad, h: 2 * l.ry + pad }; }
    case 'arrow': return { w: Math.hypot(l.x2 - l.x1, l.y2 - l.y1), h: Math.max(l.head * 2, l.width) };
  }
}
const rad = (deg: number) => (deg * Math.PI) / 180;
export function rotateAround(p: Pt, c: Pt, deg: number): Pt {
  const a = rad(deg), cos = Math.cos(a), sin = Math.sin(a), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}
/** Coins (dans l'ordre haut-gauche, haut-droit, bas-droit, bas-gauche) de la boîte tournée. */
export function corners(l: Layer, measure: Measure): Pt[] {
  const c = center(l), { w, h } = localSize(l, measure);
  const deg = l.type === 'arrow' ? (Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI : l.rotation;
  return [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }].map(p => rotateAround({ x: c.x + p.x, y: c.y + p.y }, c, deg));
}
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function hitLayer(l: Layer, p: Pt, measure: Measure, tol = 6): boolean {
  if (!l.visible) return false;
  if (l.type === 'arrow') return distToSegment(p, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }) <= Math.max(l.width / 2, l.head * 0.8) + tol;
  const q = rotateAround(p, center(l), -l.rotation);
  const c = center(l);
  if (l.type === 'circle') {
    const d = Math.hypot((q.x - c.x) / l.rx, (q.y - c.y) / l.ry);
    return Math.abs(d - 1) * Math.min(l.rx, l.ry) <= l.width / 2 + (l.outline.enabled ? l.outline.width : 0) + tol;
  }
  const { w, h } = localSize(l, measure);
  return Math.abs(q.x - c.x) <= w / 2 + tol && Math.abs(q.y - c.y) <= h / 2 + tol;
}
/** Calque le plus haut sous le point (les calques verrouillés sont ignorés). */
export function hitTest(doc: EditorDoc, p: Pt, measure: Measure, tol = 6): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) { const l = doc.layers[i]; if (!l.locked && hitLayer(l, p, measure, tol)) return l; }
  return null;
}

/** Élastique (rubber-banding) façon iOS au-delà de [min, max]. */
export function rubberBand(v: number, min: number, max: number, dim: number, c = 0.55): number {
  const rb = (x: number) => (1 - 1 / ((x * c) / dim + 1)) * dim;
  if (v < min) return min - rb(min - v);
  if (v > max) return max + rb(v - max);
  return v;
}
export const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function moveTo(l: Layer, cx: number, cy: number): Layer {
  if (l.type === 'arrow') { const c = center(l), dx = cx - c.x, dy = cy - c.y; return { ...l, x1: l.x1 + dx, y1: l.y1 + dy, x2: l.x2 + dx, y2: l.y2 + dy }; }
  return { ...l, x: cx, y: cy };
}
/** Mise à l'échelle uniforme autour du centre (factor relatif au calque fourni). */
export function scaleLayer(l: Layer, f: number): Layer {
  switch (l.type) {
    case 'image': return { ...l, scale: clampN(l.scale * f, 0.01, 40) };
    case 'text': {
      const size = clampN(l.size * f, 8, 900), k = size / l.size;
      return { ...l, size, stroke: { ...l.stroke, width: l.stroke.width * k }, shadow: { ...l.shadow, blur: l.shadow.blur * k, dx: l.shadow.dx * k, dy: l.shadow.dy * k }, glow: { ...l.glow, blur: l.glow.blur * k } };
    }
    case 'circle': return { ...l, rx: clampN(l.rx * f, 6, 3000), ry: clampN(l.ry * f, 6, 3000) };
    case 'arrow': { const c = center(l); return { ...l, x1: c.x + (l.x1 - c.x) * f, y1: c.y + (l.y1 - c.y) * f, x2: c.x + (l.x2 - c.x) * f, y2: c.y + (l.y2 - c.y) * f }; }
  }
}
/** Recadrage d'un calque image en gardant sa taille affichée (le cadre « zoome » dans l'image). */
export function setCrop(l: ImageLayer, crop: Rect): ImageLayer {
  const shownW = l.crop.w * l.scale;
  const c: Rect = { x: clampN(crop.x, 0, l.natW - 1), y: clampN(crop.y, 0, l.natH - 1), w: clampN(crop.w, 1, l.natW), h: clampN(crop.h, 1, l.natH) };
  c.x = Math.min(c.x, l.natW - c.w); c.y = Math.min(c.y, l.natH - c.h);
  return { ...l, crop: c, scale: shownW / c.w };
}
/** Cadre 16:9 de taille relative `size` (0..1 du plus grand cadre 16:9) centré sur un point source. */
export function crop169At(natW: number, natH: number, size: number, cx: number, cy: number): Rect {
  const max = crop169(natW, natH), w = max.w * clampN(size, 0.05, 1), h = max.h * clampN(size, 0.05, 1);
  return { x: clampN(cx - w / 2, 0, natW - w), y: clampN(cy - h / 2, 0, natH - h), w, h };
}

export function updateLayer(doc: EditorDoc, id: string, patch: Partial<Layer> | ((l: Layer) => Layer)): EditorDoc {
  return { ...doc, layers: doc.layers.map(l => (l.id === id ? (typeof patch === 'function' ? patch(l) : ({ ...l, ...patch } as Layer)) : l)) };
}
export const removeLayer = (doc: EditorDoc, id: string): EditorDoc => ({ ...doc, layers: doc.layers.filter(l => l.id !== id) });
export function moveLayerZ(doc: EditorDoc, id: string, dir: 1 | -1 | 'top' | 'bottom'): EditorDoc {
  const i = doc.layers.findIndex(l => l.id === id); if (i < 0) return doc;
  const layers = [...doc.layers]; const [l] = layers.splice(i, 1);
  const j = dir === 'top' ? layers.length : dir === 'bottom' ? 0 : clampN(i + dir, 0, layers.length);
  layers.splice(j, 0, l); return { ...doc, layers };
}
export function duplicateLayer(doc: EditorDoc, id: string): { doc: EditorDoc; id?: string } {
  const i = doc.layers.findIndex(l => l.id === id); if (i < 0) return { doc };
  const copy = { ...moveTo(doc.layers[i], center(doc.layers[i]).x + 24, center(doc.layers[i]).y + 24), id: newId(), name: doc.layers[i].name + ' (copie)' } as Layer;
  const layers = [...doc.layers]; layers.splice(i + 1, 0, copy); return { doc: { ...doc, layers }, id: copy.id };
}

// ── Historique (annuler / rétablir) ─────────────────────────────────────────
export interface History { past: EditorDoc[]; present: EditorDoc; future: EditorDoc[]; key?: string; at?: number }
export const historyInit = (d: EditorDoc): History => ({ past: [], present: d, future: [] });
/** Valide un nouvel état. Les changements successifs d'une même clé (curseur…) en < 700 ms sont fusionnés. */
export function commit(h: History, next: EditorDoc, key?: string, now = Date.now()): History {
  if (next === h.present) return h;
  if (key && h.key === key && now - (h.at ?? 0) < 700) return { ...h, present: next, future: [], at: now };
  return { past: [...h.past, h.present].slice(-120), present: next, future: [], key, at: now };
}
/** Fin de geste : l'état de départ devient l'entrée d'historique. */
export function commitFrom(h: History, before: EditorDoc, next: EditorDoc): History {
  if (before === next) return { ...h, present: next };
  return { past: [...h.past, before].slice(-120), present: next, future: [], key: undefined };
}
/** Pendant un geste : état affiché sans entrée d'historique. */
export const transient = (h: History, next: EditorDoc): History => ({ ...h, present: next });
export const undo = (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h);
export const redo = (h: History): History => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h);
