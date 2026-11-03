// Export 1280×720 garanti < 2 Mo (limite des miniatures YouTube). Logique testable : le canvas,
// le rendu et l'encodage sont injectés. Échelle : PNG → PNG postérisé (6, 5, 4 bits) → JPEG (repli).
export const EXPORT_W = 1280, EXPORT_H = 720;
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024;

export interface ExportCanvas { width: number; height: number }
export interface ExportDeps<C extends ExportCanvas> {
  createCanvas: (w: number, h: number) => C;
  /** Dessine le document à l'échelle 1 (1280×720). */
  render: (canvas: C) => void;
  encode: (canvas: C, type: 'image/png' | 'image/jpeg', quality?: number) => Promise<Blob>;
  /** Réduit la profondeur de couleur en place (PNG plus léger). */
  posterize?: (canvas: C, bits: number) => void;
}
export interface ExportStep { id: string; type: 'image/png' | 'image/jpeg'; bits?: number; quality?: number }
export const EXPORT_LADDER: ExportStep[] = [
  { id: 'png', type: 'image/png' },
  { id: 'png-6bits', type: 'image/png', bits: 6 },
  { id: 'png-5bits', type: 'image/png', bits: 5 },
  { id: 'png-4bits', type: 'image/png', bits: 4 },
  { id: 'jpeg-92', type: 'image/jpeg', quality: 0.92 },
  { id: 'jpeg-85', type: 'image/jpeg', quality: 0.85 },
  { id: 'jpeg-75', type: 'image/jpeg', quality: 0.75 },
  { id: 'jpeg-60', type: 'image/jpeg', quality: 0.6 },
];
export interface ExportResult { blob: Blob; width: number; height: number; type: 'image/png' | 'image/jpeg'; step: string; attempts: { step: string; bytes: number }[] }

export async function exportThumbnail<C extends ExportCanvas>(deps: ExportDeps<C>, maxBytes = MAX_EXPORT_BYTES, ladder = EXPORT_LADDER): Promise<ExportResult> {
  const attempts: { step: string; bytes: number }[] = [];
  for (const step of ladder) {
    if (step.bits && !deps.posterize) continue;
    const c = deps.createCanvas(EXPORT_W, EXPORT_H);
    if (c.width !== EXPORT_W || c.height !== EXPORT_H) throw new Error(`Canvas d'export incorrect (${c.width}×${c.height}).`);
    deps.render(c);
    if (step.bits) deps.posterize!(c, step.bits);
    const blob = await deps.encode(c, step.type, step.quality);
    attempts.push({ step: step.id, bytes: blob.size });
    if (blob.size > 0 && blob.size < maxBytes) return { blob, width: c.width, height: c.height, type: step.type, step: step.id, attempts };
  }
  throw new Error(`Impossible de passer sous ${Math.round(maxBytes / 1024 / 1024)} Mo (dernier essai : ${((attempts.at(-1)?.bytes ?? 0) / 1048576).toFixed(1)} Mo).`);
}

/** Postérisation : ramène chaque canal à 2^bits niveaux (arrondi au plus proche), alpha intact. */
export function posterizeData(data: Uint8ClampedArray, bits: number): void {
  const levels = (1 << Math.max(1, Math.min(8, bits))) - 1;
  if (levels >= 255) return;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.round((v / 255) * levels) * (255 / levels));
  for (let i = 0; i < data.length; i += 4) { data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]]; }
}
export const exportStepLabel = (step: string) => ({
  'png': 'PNG sans perte', 'png-6bits': 'PNG optimisé (couleurs 6 bits)', 'png-5bits': 'PNG optimisé (couleurs 5 bits)', 'png-4bits': 'PNG optimisé (couleurs 4 bits)',
  'jpeg-92': 'JPEG qualité 92 (PNG trop lourd)', 'jpeg-85': 'JPEG qualité 85 (PNG trop lourd)', 'jpeg-75': 'JPEG qualité 75 (PNG trop lourd)', 'jpeg-60': 'JPEG qualité 60 (PNG trop lourd)',
} as Record<string, string>)[step] ?? step;
