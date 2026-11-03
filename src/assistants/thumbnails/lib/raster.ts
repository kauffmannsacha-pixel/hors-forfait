// Raster pur (sans DOM) : image RGBA, rééchantillonnage par moyenne de surface, recadrages, flous.
import type { RGB } from './color';

export interface RGBAImage { width: number; height: number; data: Uint8ClampedArray }
export interface Rect { x: number; y: number; w: number; h: number }

export function createImage(width: number, height: number, fill: RGB = [0, 0, 0]): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255; }
  return { width, height, data };
}
export function fillRect(img: RGBAImage, r: Rect, c: RGB) {
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(img.width, Math.round(r.x + r.w)), y1 = Math.min(img.height, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; }
}

/** Poids de couverture d'un axe : pour chaque pixel cible, liste (indice source, poids) dont la somme vaut 1. */
function axisWeights(srcLen: number, dstLen: number): { idx: Int32Array; w: Float32Array; start: Int32Array } {
  const scale = srcLen / dstLen;
  const idx: number[] = [], w: number[] = [], start = new Int32Array(dstLen + 1);
  for (let i = 0; i < dstLen; i++) {
    start[i] = idx.length;
    const a = i * scale, b = a + scale;
    const j0 = Math.floor(a), j1 = Math.min(srcLen, Math.ceil(b));
    for (let j = j0; j < j1; j++) {
      const cover = Math.min(b, j + 1) - Math.max(a, j);
      if (cover > 1e-9) { idx.push(Math.min(srcLen - 1, j)); w.push(cover / scale); }
    }
  }
  start[dstLen] = idx.length;
  return { idx: Int32Array.from(idx), w: Float32Array.from(w), start };
}

/**
 * Rééchantillonnage par moyenne de surface (filtre boîte exact, couvertures fractionnaires) :
 * c'est ce qui se rapproche le plus d'un affichage réduit (fil de suggestions 168×94).
 */
export function downscaleArea(src: RGBAImage, dw: number, dh: number): RGBAImage {
  dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
  const { width: sw, height: sh, data } = src;
  const hx = axisWeights(sw, dw), hy = axisWeights(sh, dh);
  const tmp = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = hx.start[x]; k < hx.start[x + 1]; k++) {
        const i = (y * sw + hx.idx[k]) * 4, wt = hx.w[k];
        r += data[i] * wt; g += data[i + 1] * wt; b += data[i + 2] * wt; a += data[i + 3] * wt;
      }
      const o = (y * dw + x) * 4; tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = hy.start[y]; k < hy.start[y + 1]; k++) {
        const i = (hy.idx[k] * dw + x) * 4, wt = hy.w[k];
        r += tmp[i] * wt; g += tmp[i + 1] * wt; b += tmp[i + 2] * wt; a += tmp[i + 3] * wt;
      }
      const o = (y * dw + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { width: dw, height: dh, data: out };
}
/** Même rééchantillonnage pour un canal flottant (cartes de saillance). */
export function downscaleChannel(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const hx = axisWeights(sw, dw), hy = axisWeights(sh, dh);
  const tmp = new Float32Array(dw * sh), out = new Float32Array(dw * dh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < dw; x++) {
    let v = 0; for (let k = hx.start[x]; k < hx.start[x + 1]; k++) v += src[y * sw + hx.idx[k]] * hx.w[k];
    tmp[y * dw + x] = v;
  }
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let v = 0; for (let k = hy.start[y]; k < hy.start[y + 1]; k++) v += tmp[hy.idx[k] * dw + x] * hy.w[k];
    out[y * dw + x] = v;
  }
  return out;
}
/** Réduit pour tenir dans maxW × maxH (jamais d'agrandissement). */
export function fitWithin(src: RGBAImage, maxW: number, maxH: number): RGBAImage {
  const s = Math.min(1, maxW / src.width, maxH / src.height);
  return s >= 1 ? src : downscaleArea(src, Math.round(src.width * s), Math.round(src.height * s));
}
export function cropImage(src: RGBAImage, r: Rect): RGBAImage {
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.min(src.width - x0, Math.round(r.w))), h = Math.max(1, Math.min(src.height - y0, Math.round(r.h)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.data.subarray(((y0 + y) * src.width + x0) * 4, ((y0 + y) * src.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/** Plus grand rectangle 16:9 centré dans une image (recadrage). */
export function crop169(w: number, h: number, ratio = 16 / 9): Rect {
  if (w / h > ratio) { const cw = h * ratio; return { x: (w - cw) / 2, y: 0, w: cw, h }; }
  const ch = w / ratio; return { x: 0, y: (h - ch) / 2, w, h: ch };
}

/**
 * Détecte les bandes noires (letterbox) des vignettes 4:3 de YouTube (hqdefault 480×360, sddefault 640×480)
 * et renvoie la zone utile 16:9, ou null si l'image n'en a pas.
 */
export function detectLetterbox(img: RGBAImage): Rect | null {
  const { width: w, height: h, data } = img;
  if (Math.abs(w / h - 4 / 3) > 0.05) return null;
  const content = crop169(w, h);
  const band = Math.floor(content.y);
  if (band < 4) return null;
  const rowStats = (y0: number, y1: number) => {
    let sum = 0, sq = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4; const v = (data[i] + data[i + 1] + data[i + 2]) / 3; sum += v; sq += v * v; n++;
    }
    const m = sum / n; return { mean: m, std: Math.sqrt(Math.max(0, sq / n - m * m)) };
  };
  const top = rowStats(1, band - 2), bottom = rowStats(h - band + 2, h - 1);
  return top.mean < 22 && bottom.mean < 22 && top.std < 10 && bottom.std < 10
    ? { x: 0, y: Math.round(content.y), w, h: Math.round(content.h) } : null;
}

/** Gris perceptuel 0..255 (Rec. 601 sur valeurs encodées) pour netteté/bords. */
export function toGray(img: RGBAImage): Float32Array {
  const n = img.width * img.height, out = new Float32Array(n), d = img.data;
  for (let i = 0; i < n; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

/** Flou boîte séparable (rayon r), sur un canal flottant, bords répliqués. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      const add = Math.min(w - 1, x + r + 1), sub = Math.max(0, x - r);
      acc += src[y * w + add] - src[y * w + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const add = Math.min(h - 1, y + r + 1), sub = Math.max(0, y - r);
      acc += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}
/** Approximation gaussienne : 3 flous boîte successifs. */
export function gaussianBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

/** Encode/décode un tableau d'octets en base64 (stockage compact des cartes de saillance). */
export function bytesToB64(bytes: Uint8Array): string {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
