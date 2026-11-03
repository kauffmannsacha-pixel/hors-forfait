// Agrégats (purs) d'une niche : ce que font les miniatures les plus vues, et ce qui surperforme.
import type { ColorFamily } from './color';
import type { ThumbRecord } from './types';

export interface Share { key: string; share: number; count: number }
export interface FeatureLift { feature: string; withMedian: number; withoutMedian: number; withCount: number; withoutCount: number; metric: 'ratio' | 'vues' }
export interface NicheInsights {
  count: number; visionCount: number; metricsCount: number;
  faceShare: number; textShare: number; avgWords: number; avgElements: number;
  emotions: Share[]; families: Share[]; layouts: Share[];
  medianViews: number; medianRatio?: number;
  medianLegibility: number; medianContrast: number; medianColorfulness: number;
  lifts: FeatureLift[];
}

export const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const shares = (keys: string[]): Share[] => {
  const m = new Map<string, number>(); keys.forEach(k => m.set(k, (m.get(k) ?? 0) + 1));
  return [...m].map(([key, count]) => ({ key, count, share: count / (keys.length || 1) })).sort((a, b) => b.count - a.count);
};

/** Familles de couleurs marquantes d'une miniature : grandes zones (≥ 18 %) + couleur d'accent la plus vive (≥ 6 %). */
export function recordFamilies(r: ThumbRecord): ColorFamily[] {
  const pal = r.metrics?.palette ?? [];
  const out = new Set<ColorFamily>(pal.filter(p => p.share >= 0.18).map(p => p.family));
  const accent = pal.filter(p => p.share >= 0.06).sort((a, b) => Math.hypot(b.lab[1], b.lab[2]) - Math.hypot(a.lab[1], a.lab[2]))[0];
  if (accent) out.add(accent.family);
  if (!out.size && pal[0]) out.add(pal[0].family);
  return [...out];
}

export function nicheInsights(records: ThumbRecord[]): NicheInsights {
  const withV = records.filter(r => r.vision), withM = records.filter(r => r.metrics);
  const vis = withV.map(r => r.vision!);
  const textRecs = vis.filter(v => v.hasText);
  const ratios = records.map(r => r.ratio).filter((x): x is number => x != null && Number.isFinite(x));
  const useRatio = ratios.length >= Math.max(3, records.length * 0.6);
  const perf = (r: ThumbRecord) => (useRatio ? r.ratio : r.views);
  const lift = (feature: string, pred: (r: ThumbRecord) => boolean | undefined): FeatureLift | null => {
    const yes: number[] = [], no: number[] = [];
    for (const r of records) { const p = perf(r); const t = pred(r); if (p == null || t == null) continue; (t ? yes : no).push(p); }
    if (yes.length < 3 || no.length < 3) return null;
    return { feature, withMedian: median(yes), withoutMedian: median(no), withCount: yes.length, withoutCount: no.length, metric: useRatio ? 'ratio' : 'vues' };
  };
  const lifts = [
    lift('Visage', r => r.vision?.face),
    lift('Texte incrusté', r => r.vision?.hasText),
    lift('Texte ≤ 3 mots', r => (r.vision?.hasText ? r.vision.wordCount <= 3 : undefined)),
    lift('Émotion intense (≥ 7/10)', r => (r.vision?.face ? r.vision.emotionIntensity >= 7 : undefined)),
    lift('3 éléments max', r => (r.vision ? r.vision.elementCount <= 3 : undefined)),
    lift('Lisible en petit (≥ 7/10)', r => (r.metrics ? r.metrics.legibility.score >= 7 : undefined)),
    lift('Couleurs vives', r => (r.metrics ? r.metrics.colorfulness >= 60 : undefined)),
  ].filter((x): x is FeatureLift => !!x);
  return {
    count: records.length, visionCount: withV.length, metricsCount: withM.length,
    faceShare: vis.length ? vis.filter(v => v.face).length / vis.length : 0,
    textShare: vis.length ? textRecs.length / vis.length : 0,
    avgWords: textRecs.length ? textRecs.reduce((s, v) => s + v.wordCount, 0) / textRecs.length : 0,
    avgElements: vis.length ? vis.reduce((s, v) => s + v.elementCount, 0) / vis.length : 0,
    emotions: shares(vis.filter(v => v.face).map(v => v.emotion)),
    families: shares(withM.map(r => r.metrics!.palette[0]?.family).filter((x): x is ColorFamily => !!x)),
    layouts: shares(vis.map(v => v.layout)),
    medianViews: median(records.map(r => r.views)),
    medianRatio: ratios.length ? median(ratios) : undefined,
    medianLegibility: median(withM.map(r => r.metrics!.legibility.score)),
    medianContrast: median(withM.map(r => r.metrics!.rmsContrast)),
    medianColorfulness: median(withM.map(r => r.metrics!.colorfulness)),
    lifts,
  };
}
