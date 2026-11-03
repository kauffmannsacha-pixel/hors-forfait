// Mesures LOCALES d'une miniature (aucun appel réseau) : palette k-means, luminance/contraste,
// saturation et « colorfulness », netteté (variance du laplacien), saillance (point focal),
// lisibilité en petit format (rendu 168×94) et contraste WCAG du sujet sur son fond.
import { clamp01, contrastFromLuminance, deltaE, linearRgbToLab, rgbToHsv, srgbToLinear, type Lab } from './color';
import { dominantColors, type PaletteColor } from './kmeans';
import { boxBlur, bytesToB64, downscaleArea, downscaleChannel, fitWithin, gaussianBlur, toGray, type RGBAImage } from './raster';

export const SMALL_W = 168, SMALL_H = 94;

export interface Legibility {
  width: number; height: number;
  contrastRatio: number;   // WCAG : zone saillante vs reste, en petit format
  deltaE: number;          // écart de couleur zone saillante vs reste
  rms: number;             // contraste RMS (écart-type L*/100) en petit format
  edge: number;            // force moyenne des contours (Sobel normalisé) en petit format
  score: number;           // /10
}
export interface MetricScores { contrast: number; color: number; sharpness: number; legibility: number; focus: number; overall: number }
export interface ImageMetrics {
  width: number; height: number; aspect: number;
  palette: PaletteColor[];
  luminance: { mean: number; std: number; p5: number; p95: number };   // L* 0..100
  rmsContrast: number;      // écart-type L* / 100
  dynamicRange: number;     // p95 − p5 (L*)
  saturation: number;       // saturation HSV moyenne 0..1
  colorfulness: number;     // Hasler & Süsstrunk (0 = gris, > 80 = très coloré)
  sharpness: number;        // variance du laplacien (gris 0..255, à ≤ 640 px)
  focal: { x: number; y: number; concentration: number; blobs: number };
  focalContrast: number;    // WCAG zone saillante vs fond (pleine taille)
  focalDeltaE: number;
  cornerSaliency: number;   // part de saillance dans le coin bas-droit (masqué par la durée)
  thirds: 'centre' | 'tiers' | 'bord' | 'libre';
  legibility: Legibility;
  saliency: { w: number; h: number; b64: string };  // carte 48×27 (0..255) pour la surcouche
  scores: MetricScores;
}

export interface Planes { w: number; h: number; L: Float32Array; A: Float32Array; B: Float32Array; Y: Float32Array }
export function planes(img: RGBAImage): Planes {
  const n = img.width * img.height, d = img.data;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lr = srgbToLinear(d[i * 4]), lg = srgbToLinear(d[i * 4 + 1]), lb = srgbToLinear(d[i * 4 + 2]);
    const lab = linearRgbToLab(lr, lg, lb);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2]; Y[i] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  }
  return { w: img.width, h: img.height, L, A, B, Y };
}

const normalize = (a: Float32Array) => { let m = 0; for (const v of a) if (v > m) m = v; if (m > 0) for (let i = 0; i < a.length; i++) a[i] /= m; return a; };

/**
 * Carte de saillance (0..1) : moyenne de la saillance « frequency-tuned » (Achanta 2009 :
 * distance Lab à la couleur moyenne) et d'un contraste centre-pourtour multi-échelle.
 */
export function saliencyMap(p: Planes): Float32Array {
  const { w, h, L, A, B } = p, n = w * h;
  let mL = 0, mA = 0, mB = 0;
  for (let i = 0; i < n; i++) { mL += L[i]; mA += A[i]; mB += B[i]; }
  mL /= n; mA /= n; mB /= n;
  const fine = [gaussianBlur(L, w, h, 1), gaussianBlur(A, w, h, 1), gaussianBlur(B, w, h, 1)];
  const rC = Math.max(3, Math.round(Math.min(w, h) / 10));
  const coarse = [gaussianBlur(L, w, h, rC), gaussianBlur(A, w, h, rC), gaussianBlur(B, w, h, rC)];
  const ft = new Float32Array(n), cs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ft[i] = Math.hypot(fine[0][i] - mL, fine[1][i] - mA, fine[2][i] - mB);
    cs[i] = Math.hypot(fine[0][i] - coarse[0][i], fine[1][i] - coarse[1][i], fine[2][i] - coarse[2][i]);
  }
  normalize(ft); normalize(cs);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.5 * ft[i] + 0.5 * cs[i];
  return normalize(gaussianBlur(s, w, h, 1));
}

const quantile = (vals: Float32Array, q: number) => { const s = Float32Array.from(vals).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

/** Point focal (barycentre des 5 % les plus saillants), concentration et nombre de zones saillantes. */
export function focalAnalysis(sal: Float32Array, w: number, h: number): ImageMetrics['focal'] & { corner: number } {
  const n = w * h;
  let total = 0; for (const v of sal) total += v * v;
  if (total <= 1e-9) return { x: 0.5, y: 0.5, concentration: 0, blobs: 0, corner: 0 };
  const t = quantile(sal, 0.95);
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = sal[y * w + x]; if (v >= t) { sx += x * v; sy += y * v; sw += v; } }
  const fx = sw ? sx / sw : w / 2, fy = sw ? sy / sw : h / 2;
  const R = 0.2 * w;
  let inside = 0, corner = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = sal[y * w + x], m = v * v;
    if (Math.hypot(x - fx, y - fy) <= R) inside += m;
    if (x >= 0.82 * w && y >= 0.8 * h) corner += m;
  }
  // zones saillantes : composantes connexes au-dessus de moyenne + 1,5 σ
  let mean = 0; for (const v of sal) mean += v; mean /= n;
  let vr = 0; for (const v of sal) vr += (v - mean) ** 2; const thr = mean + 1.5 * Math.sqrt(vr / n);
  const seen = new Uint8Array(n), minSize = Math.max(4, Math.round(0.004 * n));
  let blobs = 0; const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || sal[i] < thr) continue;
    let size = 0; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!; size++;
      const x = j % w, y = (j - x) / w;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && !seen[k] && sal[k] >= thr) { seen[k] = 1; stack.push(k); }
    }
    if (size >= minSize) blobs++;
  }
  return { x: fx / Math.max(1, w - 1), y: fy / Math.max(1, h - 1), concentration: inside / total, blobs: Math.min(12, blobs), corner: corner / total };
}

/** Contraste WCAG et ΔE entre la zone la plus saillante (topFrac) et le reste de l'image. */
export function regionContrast(p: Planes, sal: Float32Array, topFrac = 0.15): { ratio: number; deltaE: number } {
  const t = quantile(sal, 1 - topFrac);
  let y1 = 0, n1 = 0, y0 = 0, n0 = 0; const l1: Lab = [0, 0, 0], l0: Lab = [0, 0, 0];
  for (let i = 0; i < sal.length; i++) {
    if (sal[i] >= t && sal[i] > 0) { y1 += p.Y[i]; n1++; l1[0] += p.L[i]; l1[1] += p.A[i]; l1[2] += p.B[i]; }
    else { y0 += p.Y[i]; n0++; l0[0] += p.L[i]; l0[1] += p.A[i]; l0[2] += p.B[i]; }
  }
  if (!n1 || !n0) return { ratio: 1, deltaE: 0 };
  return { ratio: contrastFromLuminance(y1 / n1, y0 / n0), deltaE: deltaE(l1.map(v => v / n1) as Lab, l0.map(v => v / n0) as Lab) };
}

export function luminanceStats(L: Float32Array) {
  const hist = new Uint32Array(101); let sum = 0, sq = 0;
  for (const v of L) { const c = Math.max(0, Math.min(100, Math.round(v))); hist[c]++; sum += v; sq += v * v; }
  const n = L.length || 1, mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const pct = (q: number) => { let acc = 0; for (let i = 0; i <= 100; i++) { acc += hist[i]; if (acc >= q * n) return i; } return 100; };
  return { mean, std, p5: pct(0.05), p95: pct(0.95) };
}

/** Variance du laplacien (netteté) sur un plan de gris 0..255. */
export function laplacianVariance(g: Float32Array, w: number, h: number): number {
  let s = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; const v = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
    s += v; sq += v * v; n++;
  }
  if (!n) return 0; const m = s / n; return Math.max(0, sq / n - m * m);
}
/** Force moyenne des contours (Sobel), normalisée par 4×255. */
export function edgeStrength(g: Float32Array, w: number, h: number): number {
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
    const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
    s += Math.hypot(gx, gy); n++;
  }
  return n ? s / n / 1020 : 0;
}
/** Colorfulness de Hasler & Süsstrunk (2003) et saturation HSV moyenne. */
export function colorStats(img: RGBAImage): { colorfulness: number; saturation: number } {
  const d = img.data, n = img.width * img.height;
  let mrg = 0, myb = 0, srg = 0, syb = 0, sat = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const rg = r - g, yb = 0.5 * (r + g) - b;
    mrg += rg; myb += yb; srg += rg * rg; syb += yb * yb; sat += rgbToHsv([r, g, b])[1];
  }
  mrg /= n; myb /= n;
  const vrg = Math.max(0, srg / n - mrg * mrg), vyb = Math.max(0, syb / n - myb * myb);
  return { colorfulness: Math.sqrt(vrg + vyb) + 0.3 * Math.hypot(mrg, myb), saturation: sat / n };
}

/** Lisibilité en petit format : rendu 168×94 (moyenne de surface) puis contrastes de ce rendu. */
export function smallFormatLegibility(img: RGBAImage, w = SMALL_W, h?: number): Legibility {
  // 16:9 → exactement 168×94 (taille du fil de suggestions) ; autres ratios : hauteur proportionnelle.
  const hh = h ?? (Math.abs(img.width / img.height - 16 / 9) < 0.02 ? SMALL_H : Math.max(1, Math.round(w * img.height / img.width)));
  const small = downscaleArea(img, w, hh);
  const p = planes(small);
  const sal = saliencyMap(p);
  const { ratio, deltaE: dE } = regionContrast(p, sal);
  const rms = luminanceStats(p.L).std / 100;
  // léger flou 3×3 avant Sobel : on mesure la structure qui survit, pas le crénelage des détails fins
  const edge = edgeStrength(boxBlur(toGray(small), small.width, small.height, 1), small.width, small.height);
  const score = 10 * (0.45 * clamp01((ratio - 1) / 5) + 0.2 * clamp01(dE / 45) + 0.2 * clamp01(rms / 0.25) + 0.15 * clamp01(edge / 0.06));
  return { width: small.width, height: small.height, contrastRatio: ratio, deltaE: dE, rms, edge, score: Math.round(score * 10) / 10 };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
export function scoreMetrics(m: Omit<ImageMetrics, 'scores'>): MetricScores {
  const contrast = 10 * (0.6 * clamp01(m.rmsContrast / 0.25) + 0.4 * clamp01(m.dynamicRange / 85));
  const color = 10 * (0.7 * clamp01((m.colorfulness - 20) / 70) + 0.3 * clamp01(m.saturation / 0.55));
  const sharpness = 10 * clamp01((Math.log10(Math.max(1, m.sharpness)) - 1.5) / 1.7);
  const focus = Math.max(0, Math.min(10, 10 * clamp01((m.focal.concentration - 0.12) / 0.38) - Math.max(0, m.focal.blobs - 4) * 0.8));
  const legibility = m.legibility.score;
  const overall = 0.3 * legibility + 0.2 * contrast + 0.2 * focus + 0.15 * color + 0.15 * sharpness;
  return { contrast: r1(contrast), color: r1(color), sharpness: r1(sharpness), legibility: r1(legibility), focus: r1(focus), overall: r1(overall) };
}

function thirdsOf(x: number, y: number): ImageMetrics['thirds'] {
  const dc = Math.hypot(x - 0.5, y - 0.5);
  const dt = Math.min(...[1 / 3, 2 / 3].flatMap(a => [1 / 3, 2 / 3].map(b => Math.hypot(x - a, y - b))));
  if (dc < 0.12 && dc <= dt) return 'centre';
  if (dt < 0.12) return 'tiers';
  if (x < 0.12 || x > 0.88 || y < 0.12 || y > 0.88) return 'bord';
  return 'libre';
}

/** Toutes les mesures locales d'une image (opaque). */
export function computeMetrics(img: RGBAImage, opts: { k?: number; seed?: number } = {}): ImageMetrics {
  const work = fitWithin(img, 640, 640);
  const tiny = downscaleArea(img, 160, Math.max(1, Math.round(160 * img.height / img.width)));
  const p = planes(tiny);
  const allColors = dominantColors(tiny, opts.k ?? 5, { seed: opts.seed ?? 7 });
  // on écarte les micro-clusters (pixels de transition des bords) sauf s'il ne reste rien
  const palette = allColors.filter(p => p.share >= 0.02).length ? allColors.filter(p => p.share >= 0.02) : allColors.slice(0, 1);
  const lum = luminanceStats(p.L);
  const { colorfulness, saturation } = colorStats(tiny);
  const sharpness = laplacianVariance(toGray(work), work.width, work.height);
  const sal = saliencyMap(p);
  const fa = focalAnalysis(sal, tiny.width, tiny.height);
  const rc = regionContrast(p, sal);
  const legibility = smallFormatLegibility(img);
  const sw = 48, sh = Math.max(1, Math.round(48 * tiny.height / tiny.width));
  const map = downscaleChannel(sal, tiny.width, tiny.height, sw, sh);
  let mx = 0; for (const v of map) mx = Math.max(mx, v);
  const bytes = Uint8Array.from(map, v => (mx > 0 ? Math.round((v / mx) * 255) : 0));
  const base: Omit<ImageMetrics, 'scores'> = {
    width: img.width, height: img.height, aspect: img.width / img.height,
    palette, luminance: lum, rmsContrast: lum.std / 100, dynamicRange: lum.p95 - lum.p5,
    saturation, colorfulness, sharpness,
    focal: { x: fa.x, y: fa.y, concentration: fa.concentration, blobs: fa.blobs },
    focalContrast: rc.ratio, focalDeltaE: rc.deltaE, cornerSaliency: fa.corner,
    thirds: thirdsOf(fa.x, fa.y), legibility,
    saliency: { w: sw, h: sh, b64: bytesToB64(bytes) },
  };
  return { ...base, scores: scoreMetrics(base) };
}

// ── Retours rédigés à partir des mesures ───────────────────────────────────
export interface MetricFeedback { level: 'bon' | 'moyen' | 'faible'; text: string; keywords: string[] }
const fr = (v: number, d = 1) => v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const fmtRatio = (v: number) => `${fr(v, 1)}:1`;

export function metricsFeedback(m: ImageMetrics): MetricFeedback[] {
  const out: MetricFeedback[] = [];
  const L = m.legibility;
  if (L.score >= 7) out.push({ level: 'bon', text: `Se lit bien en 168×94 : le sujet ressort à ${fmtRatio(L.contrastRatio)} sur son fond (WCAG ≥ 3:1 pour du grand texte).`, keywords: ['lisib', 'petit', 'contraste'] });
  else if (L.score >= 4.5) out.push({ level: 'moyen', text: `Lisibilité moyenne en 168×94 (sujet à ${fmtRatio(L.contrastRatio)} du fond) : grossis le sujet et assombris/éclaircis le fond pour dépasser 4,5:1.`, keywords: ['lisib', 'petit', 'contraste'] });
  else out.push({ level: 'faible', text: `Illisible en petit format (168×94) : le sujet n'est qu'à ${fmtRatio(L.contrastRatio)} du fond. Simplifie, agrandis le sujet ou ajoute un contour clair/sombre.`, keywords: ['lisib', 'petit', 'contraste', 'simpl'] });
  if (m.rmsContrast < 0.16) out.push({ level: 'faible', text: `Contraste global faible (écart-type L* ${fr(m.rmsContrast * 100, 0)}) : l'image paraît terne dans un fil. Monte le contraste ou sépare clair/sombre.`, keywords: ['contraste'] });
  else if (m.rmsContrast > 0.24) out.push({ level: 'bon', text: `Contraste global fort (écart-type L* ${fr(m.rmsContrast * 100, 0)}).`, keywords: ['contraste'] });
  if (m.luminance.mean < 28) out.push({ level: 'moyen', text: `Image sombre (luminosité moyenne L* ${fr(m.luminance.mean, 0)}/100) : en mode sombre elle se fondra dans le fond du fil.`, keywords: ['lumin', 'sombre'] });
  if (m.luminance.mean > 82) out.push({ level: 'moyen', text: `Image très claire (L* ${fr(m.luminance.mean, 0)}/100) : en mode clair elle se fondra dans le fond blanc du fil.`, keywords: ['lumin', 'clair'] });
  if (m.colorfulness < 30) out.push({ level: 'moyen', text: `Couleurs ternes (colorfulness ${fr(m.colorfulness, 0)}) : une couleur saturée ou complémentaire attire l'œil dans le fil.`, keywords: ['couleur', 'satur'] });
  else if (m.colorfulness > 70) out.push({ level: 'bon', text: `Couleurs vives (colorfulness ${fr(m.colorfulness, 0)}).`, keywords: ['couleur'] });
  if (m.sharpness < 120) out.push({ level: 'faible', text: `Image floue (variance du laplacien ${fr(m.sharpness, 0)}) : utilise une source plus nette ou accentue le sujet.`, keywords: ['net', 'flou', 'qualit'] });
  if (m.focal.concentration < 0.2 || m.focal.blobs > 4) out.push({ level: 'moyen', text: `Regard dispersé : ${m.focal.blobs} zones saillantes, ${fr(m.focal.concentration * 100, 0)} % de l'attention sur le point focal. Garde 1 à 3 éléments forts.`, keywords: ['focal', 'élément', 'simpl', 'attention'] });
  else out.push({ level: 'bon', text: `Point focal clair (${fr(m.focal.concentration * 100, 0)} % de la saillance autour du sujet, ${m.thirds === 'tiers' ? 'sur un point des tiers' : m.thirds === 'centre' ? 'au centre' : m.thirds === 'bord' ? 'près d\'un bord' : 'hors tiers'}).`, keywords: ['focal'] });
  if (m.cornerSaliency > 0.12) out.push({ level: 'faible', text: `Un élément important est dans le coin bas-droit (${fr(m.cornerSaliency * 100, 0)} % de la saillance) : il sera caché par la durée de la vidéo.`, keywords: ['coin', 'durée', 'placement'] });
  if (Math.abs(m.aspect - 16 / 9) > 0.03) out.push({ level: 'faible', text: `Format ${m.width}×${m.height} (ratio ${fr(m.aspect, 2)}) : utilise 1280×720 (16:9), sinon la plateforme ajoutera des bandes ou recadrera.`, keywords: ['format', '16:9'] });
  return out;
}
