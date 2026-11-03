// k-means++ déterministe (graine) dans l'espace CIELAB → palette de couleurs dominantes.
import type { RGBAImage } from './raster';
import { colorFamily, colorName, deltaE, linearRgbToLab, rgbToHex, srgbToLinear, type ColorFamily, type Lab, type RGB } from './color';

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KMeansResult {
  centers: number[][];        // k' centres (k' ≤ k si moins de points distincts)
  assignments: Int32Array;    // cluster de chaque point
  counts: number[];
  iterations: number;
}

/**
 * k-means++ sur des points de dimension `dim` stockés à plat (n × dim).
 * Initialisation k-means++ (probabilité ∝ D²), itérations de Lloyd, ré-amorçage des clusters vides
 * sur le point le plus éloigné. Arrêt quand le plus grand déplacement de centre < tol.
 */
export function kmeans(points: ArrayLike<number>, dim: number, k: number, opts: { maxIter?: number; seed?: number; tol?: number } = {}): KMeansResult {
  const n = Math.floor(points.length / dim);
  const maxIter = opts.maxIter ?? 30, tol = opts.tol ?? 0.05;
  const rnd = mulberry32(opts.seed ?? 1);
  const assignments = new Int32Array(n);
  if (n === 0 || k <= 0) return { centers: [], assignments, counts: [], iterations: 0 };
  const dist2 = (i: number, c: number[]) => { let s = 0; for (let d = 0; d < dim; d++) { const v = points[i * dim + d] - c[d]; s += v * v; } return s; };
  const pointAt = (i: number) => { const p: number[] = []; for (let d = 0; d < dim; d++) p.push(points[i * dim + d]); return p; };

  // k-means++
  const centers: number[][] = [pointAt(Math.floor(rnd() * n))];
  const minD = new Float64Array(n);
  for (let i = 0; i < n; i++) minD[i] = dist2(i, centers[0]);
  while (centers.length < Math.min(k, n)) {
    let sum = 0; for (let i = 0; i < n; i++) sum += minD[i];
    if (sum <= 1e-12) break; // plus de points distincts
    let r = rnd() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { r -= minD[i]; if (r <= 0) { pick = i; break; } }
    const c = pointAt(pick); centers.push(c);
    for (let i = 0; i < n; i++) { const d = dist2(i, c); if (d < minD[i]) minD[i] = d; }
  }

  const kk = centers.length;
  const counts = new Array<number>(kk).fill(0);
  let it = 0;
  for (; it < maxIter; it++) {
    // affectation
    counts.fill(0);
    const sums = Array.from({ length: kk }, () => new Float64Array(dim));
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < kk; c++) { const d = dist2(i, centers[c]); if (d < bd) { bd = d; best = c; } }
      assignments[i] = best; counts[best]++;
      for (let d = 0; d < dim; d++) sums[best][d] += points[i * dim + d];
    }
    // mise à jour
    let shift = 0;
    for (let c = 0; c < kk; c++) {
      if (counts[c] === 0) {
        // cluster vide : ré-amorçage sur le point le plus éloigné de son centre
        let far = 0, fd = -1;
        for (let i = 0; i < n; i++) { const d = dist2(i, centers[assignments[i]]); if (d > fd) { fd = d; far = i; } }
        const p = pointAt(far); shift = Math.max(shift, Math.sqrt(dist2(far, centers[c]))); centers[c] = p;
        continue;
      }
      const next = Array.from(sums[c], v => v / counts[c]);
      let s = 0; for (let d = 0; d < dim; d++) { const v = next[d] - centers[c][d]; s += v * v; }
      shift = Math.max(shift, Math.sqrt(s)); centers[c] = next;
    }
    if (shift < tol) { it++; break; }
  }
  // affectation finale cohérente avec les centres retournés
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < kk; c++) { const d = dist2(i, centers[c]); if (d < bd) { bd = d; best = c; } }
    assignments[i] = best; counts[best]++;
  }
  return { centers, assignments, counts, iterations: it };
}

export interface PaletteColor { hex: string; rgb: RGB; lab: Lab; share: number; family: ColorFamily; name: string }

/**
 * Couleurs dominantes d'une image : échantillonnage en grille régulière (déterministe), k-means++ en Lab,
 * couleur de chaque cluster = moyenne sRGB de ses pixels, fusion des clusters quasi identiques (ΔE < mergeDE),
 * tri par part décroissante.
 */
export function dominantColors(img: RGBAImage, k = 5, opts: { maxSamples?: number; seed?: number; mergeDE?: number } = {}): PaletteColor[] {
  const { width: w, height: h, data } = img;
  const total = w * h;
  if (!total) return [];
  const maxSamples = opts.maxSamples ?? 6000;
  const step = Math.max(1, Math.sqrt(total / maxSamples));
  const pts: number[] = []; const rgbs: number[] = [];
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const i = (Math.floor(y) * w + Math.floor(x)) * 4;
      if (data[i + 3] < 128) continue;
      const lab = linearRgbToLab(srgbToLinear(data[i]), srgbToLinear(data[i + 1]), srgbToLinear(data[i + 2]));
      pts.push(lab[0], lab[1], lab[2]); rgbs.push(data[i], data[i + 1], data[i + 2]);
    }
  }
  const n = pts.length / 3;
  if (!n) return [];
  const res = kmeans(pts, 3, k, { seed: opts.seed ?? 7 });
  const acc = res.centers.map(() => ({ r: 0, g: 0, b: 0, L: 0, A: 0, B: 0, n: 0 }));
  for (let i = 0; i < n; i++) {
    const a = acc[res.assignments[i]];
    a.r += rgbs[i * 3]; a.g += rgbs[i * 3 + 1]; a.b += rgbs[i * 3 + 2];
    a.L += pts[i * 3]; a.A += pts[i * 3 + 1]; a.B += pts[i * 3 + 2]; a.n++;
  }
  let groups = acc.filter(a => a.n > 0).map(a => ({ rgb: [a.r / a.n, a.g / a.n, a.b / a.n] as RGB, lab: [a.L / a.n, a.A / a.n, a.B / a.n] as Lab, n: a.n }));
  // fusion des quasi-doublons
  const mergeDE = opts.mergeDE ?? 6;
  groups.sort((a, b) => b.n - a.n);
  const merged: typeof groups = [];
  for (const g of groups) {
    const t = merged.find(m => deltaE(m.lab, g.lab) < mergeDE);
    if (!t) { merged.push({ ...g }); continue; }
    const s = t.n + g.n;
    t.rgb = [0, 1, 2].map(j => (t.rgb[j] * t.n + g.rgb[j] * g.n) / s) as RGB;
    t.lab = [0, 1, 2].map(j => (t.lab[j] * t.n + g.lab[j] * g.n) / s) as Lab;
    t.n = s;
  }
  groups = merged.sort((a, b) => b.n - a.n);
  return groups.map(g => {
    const rgb = g.rgb.map(v => Math.round(v)) as RGB;
    return { hex: rgbToHex(rgb), rgb, lab: g.lab, share: g.n / n, family: colorFamily(rgb), name: colorName(rgb) };
  });
}
