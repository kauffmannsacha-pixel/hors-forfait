// Couleurs : sRGB ↔ linéaire ↔ XYZ ↔ CIELAB, luminance relative et contraste WCAG 2.x,
// familles de couleurs (filtres du mur d'inspiration) et noms français.
export type RGB = [number, number, number];          // 0..255 (sRGB encodé)
export type Lab = [number, number, number];          // L* 0..100, a*, b*

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);

/** Table de linéarisation sRGB (WCAG 2.x : seuil 0,04045 — correction officielle de 0,03928). */
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const s = i / 255; LIN[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
export const srgbToLinear = (c: number) => LIN[clamp(Math.round(c), 0, 255)];
export const linearToSrgb = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(Math.round(c * 255), 0, 255);
};

/** Luminance relative WCAG (0 = noir, 1 = blanc). */
export const relativeLuminance = ([r, g, b]: RGB) => 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
/** Ratio de contraste WCAG à partir de deux luminances relatives (1 à 21). */
export function contrastFromLuminance(l1: number, l2: number): number {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
/** Ratio de contraste WCAG entre deux couleurs (1:1 à 21:1). */
export const contrastRatio = (a: RGB, b: RGB) => contrastFromLuminance(relativeLuminance(a), relativeLuminance(b));
/** Niveau WCAG 2.x d'un ratio (texte normal ou grand texte). */
export function wcagLevel(ratio: number, largeText = false): 'AAA' | 'AA' | 'AA grand texte' | 'insuffisant' {
  if (largeText) return ratio >= 4.5 ? 'AAA' : ratio >= 3 ? 'AA' : 'insuffisant';
  return ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA grand texte' : 'insuffisant';
}

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}/i.test(h)) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const rgbToHex = ([r, g, b]: RGB) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export const isHexColor = (s: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());

/** HSV : h 0..360, s 0..1, v 0..1. */
export function rgbToHsv([r, g, b]: RGB): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6; else if (max === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

// CIELAB (D65)
const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const finv = (t: number) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
export function linearRgbToLab(lr: number, lg: number, lb: number): Lab {
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb) / YN;
  const z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / ZN;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const rgbToLab = ([r, g, b]: RGB): Lab => linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = finv(fx) * XN, y = finv(fy) * YN, z = finv(fz) * ZN;
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(clamp01(lr)), linearToSrgb(clamp01(lg)), linearToSrgb(clamp01(lb))];
}
/** Distance CIE76 (ΔE*ab). */
export const deltaE = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** L* d'une luminance relative. */
export const luminanceToLstar = (y: number) => 116 * f(y) - 16;

// ── Familles (filtre « couleur dominante ») ────────────────────────────────
export type ColorFamily = 'rouge' | 'orange' | 'jaune' | 'vert' | 'cyan' | 'bleu' | 'violet' | 'rose' | 'marron' | 'noir' | 'blanc' | 'gris';
export const COLOR_FAMILIES: ColorFamily[] = ['rouge', 'orange', 'jaune', 'vert', 'cyan', 'bleu', 'violet', 'rose', 'marron', 'noir', 'blanc', 'gris'];
/** Pastille représentative de chaque famille (affichage des filtres). */
export const FAMILY_SWATCH: Record<ColorFamily, string> = {
  rouge: '#e5322d', orange: '#f28a1c', jaune: '#f5d000', vert: '#2fb24c', cyan: '#18c3d6', bleu: '#2d6ff0',
  violet: '#8a4ce6', rose: '#f05aa6', marron: '#8b5a2b', noir: '#151515', blanc: '#f7f7f7', gris: '#8e8e93',
};
export function colorFamily(rgb: RGB): ColorFamily {
  const [L, a, b] = rgbToLab(rgb);
  const C = Math.hypot(a, b);
  if (L < 16) return 'noir';
  if (C < 12) return L > 86 ? 'blanc' : L < 24 ? 'noir' : 'gris';
  const [h] = rgbToHsv(rgb);
  if (h >= 12 && h < 45 && L < 52 && C < 60) return 'marron';
  if (h < 12 || h >= 345) return L > 72 && C < 55 ? 'rose' : 'rouge';
  if (h < 42) return 'orange';
  if (h < 68) return 'jaune';
  if (h < 160) return 'vert';
  if (h < 196) return 'cyan';
  if (h < 255) return 'bleu';
  if (h < 290) return 'violet';
  return 'rose';
}
/** Nom lisible : « rouge vif », « bleu foncé », « gris clair »… */
export function colorName(rgb: RGB): string {
  const fam = colorFamily(rgb);
  if (fam === 'noir' || fam === 'blanc') return fam;
  const [L, a, b] = rgbToLab(rgb);
  const C = Math.hypot(a, b);
  const fem = fam === 'rose';
  if (fam === 'gris') return L > 70 ? 'gris clair' : L < 38 ? 'gris foncé' : 'gris';
  if (C > 62 && L > 40) return `${fam} vif`;
  if (L < 35) return `${fam} foncé`;
  if (L > 78) return `${fam} clair`;
  if (C < 28) return `${fam} ${fem ? 'pâle' : 'désaturé'}`;
  return fam;
}
/** Couleur de texte lisible (noir/blanc) sur un fond donné. */
export const readableOn = (bg: RGB): '#000000' | '#ffffff' => contrastRatio(bg, [0, 0, 0]) >= contrastRatio(bg, [255, 255, 255]) ? '#000000' : '#ffffff';
