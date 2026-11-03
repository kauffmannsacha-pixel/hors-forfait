// Analyse de MA miniature : mesures locales + Claude Vision + principes sourcés → score /10 et retours.
// Fournit aussi l'implémentation de `scoreThumbnail` (contrat src/assistants/scores.ts).
import type { ScoreResult } from '../../scores';
import { formatCitation, type Principle } from '../../../knowledge/api';
import { inNiche, useThumbs } from '../state';
import { canvasToVision, decodeBlob, fetchImageBlob, rasterize, sizeOf, smallPreviewCanvas, toVisionJpeg } from './browserImage';
import { nicheInsights, type NicheInsights } from './insights';
import { computeMetrics, metricsFeedback, type ImageMetrics } from './metrics';
import { stripAccents } from './normalize';
import { b64ToBytes } from './raster';
import type { MyAnalysis, MyCritique } from './types';
import { critiqueMine, thumbnailPrinciples } from './vision';

/** Score final : 60 % jugement Vision, 40 % mesures locales (ou l'un des deux s'il manque l'autre). */
export function combineScore(local?: number, vision?: number): number {
  const r = (v: number) => Math.round(Math.min(10, Math.max(0, v)) * 10) / 10;
  if (local != null && vision != null) return r(0.6 * vision + 0.4 * local);
  return r(vision ?? local ?? 0);
}
const norm = (s: string) => stripAccents(s).toLowerCase();
/** Principe dont le titre/texte contient l'un des mots-clés (pour sourcer un retour issu des mesures). */
export function matchPrinciple(ps: Principle[], keywords: string[]): Principle | undefined {
  return ps.find(p => keywords.some(k => norm(`${p.title} ${p.text}`).includes(norm(k))));
}

export interface ReasonItem { text: string; level: 'bon' | 'moyen' | 'faible'; source: 'vision' | 'mesure'; citations: string[] }
/** Retours ordonnés : problèmes graves d'abord, puis moyens, puis points forts. */
export function buildReasons(metrics: ImageMetrics | undefined, critique: MyCritique | undefined, principles: Principle[]): ReasonItem[] {
  const out: ReasonItem[] = [];
  if (critique) {
    for (const p of critique.problems) out.push({ text: p.fix ? `${p.issue} → ${p.fix}` : p.issue, level: p.severity === 'haute' ? 'faible' : p.severity === 'moyenne' ? 'moyen' : 'bon', source: 'vision', citations: p.citations });
    for (const s of critique.strengths) out.push({ text: s, level: 'bon', source: 'vision', citations: [] });
  }
  if (metrics) for (const f of metricsFeedback(metrics)) {
    const p = f.level !== 'bon' ? matchPrinciple(principles, f.keywords) : undefined;
    out.push({ text: f.text, level: f.level, source: 'mesure', citations: p ? [formatCitation(p)] : [] });
  }
  const rank = { faible: 0, moyen: 1, bon: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

export interface AnalyzeInput { blob: Blob; name: string; hash?: string; title?: string; niche?: string; vision?: boolean; signal?: AbortSignal }
export interface FullAnalysis extends MyAnalysis { items: ReasonItem[]; insights?: NicheInsights; principles: Principle[] }

export async function analyzeMyThumbnail(input: AnalyzeInput): Promise<FullAnalysis> {
  const src = await decodeBlob(input.blob);
  const { w, h } = sizeOf(src);
  let metrics: ImageMetrics | undefined, metricsError: string | undefined;
  try { metrics = computeMetrics(rasterize(src, { maxW: 1280, maxH: 1280 })); } catch (e) { metricsError = (e as Error).message; }
  const lib = useThumbs.getState().library;
  const nicheRecs = input.niche ? Object.values(lib).filter(r => inNiche(r, input.niche!)) : [];
  const insights = nicheRecs.length >= 5 ? nicheInsights(nicheRecs) : undefined;
  const principles = await thumbnailPrinciples(['miniature lisible contraste visage émotion texte', input.title, input.niche].filter(Boolean).join(' '), 8);
  let critique: MyCritique | undefined, critiqueError: string | undefined;
  if (input.vision !== false) {
    try {
      // vue « fil de suggestions » : contenue en 16:9 (bandes si l'image n'est pas en 16:9)
      const r = w / h > 16 / 9 ? { x: 0, y: (h - w * 9 / 16) / 2, w, h: w * 9 / 16 } : { x: (w - h * 16 / 9) / 2, y: 0, w: h * 16 / 9, h };
      const small = await canvasToVision(smallPreviewCanvas(src, Math.abs(w / h - 16 / 9) < 0.02 ? undefined : r));
      critique = await critiqueMine({ image: await toVisionJpeg(src, { maxW: 1280 }), small, metrics, title: input.title, niche: input.niche, insights }, principles, { signal: input.signal });
    } catch (e) { critiqueError = (e as Error).message; if ((e as Error).name === 'AbortError') throw e; }
  }
  if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) src.close();
  if (!metrics && !critique) throw new Error(critiqueError ?? metricsError ?? 'Analyse impossible.');
  const items = buildReasons(metrics, critique, principles);
  const citations = [...new Set([...(critique?.citations ?? []), ...items.flatMap(i => i.citations)])];
  return {
    id: crypto.randomUUID(), at: Date.now(), name: input.name, hash: input.hash, title: input.title, niche: input.niche,
    metrics, critique, critiqueError, score: combineScore(metrics?.scores.overall, critique?.score),
    reasons: items.map(i => i.text), citations, items, insights, principles,
  };
}

/** Implémentation du contrat `scoreThumbnail` (checklist de publication, Studio…). */
export async function scoreThumbnailImpl(image: { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | { url: string }, ctx?: { title?: string; niche?: string }): Promise<ScoreResult> {
  const blob = 'url' in image ? await fetchImageBlob(image.url) : new Blob([b64ToBytes(image.base64) as BlobPart], { type: image.mediaType });
  const a = await analyzeMyThumbnail({ blob, name: 'miniature', title: ctx?.title, niche: ctx?.niche });
  const head = a.critique?.verdict ? [a.critique.verdict] : a.critiqueError ? [`Analyse Vision indisponible (${a.critiqueError}) : score fondé sur les mesures locales.`] : [];
  return { score: a.score, reasons: [...head, ...a.reasons].slice(0, 12), citations: a.citations.length ? a.citations : undefined };
}
