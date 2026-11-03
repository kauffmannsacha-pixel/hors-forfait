// Lecture (pure) des tests A/B enregistrés par le module publication (kv 'abtests') :
// agrégation des périodes par variante, CTR pondéré, meneur et indice de confiance (test z à deux proportions).

export interface AbPeriod { start?: string | number; end?: string | number; impressions: number; ctr: number; views: number; avgViewDuration: number }
export interface AbVariant { thumbnailHash?: string; title?: string; periods: AbPeriod[] }
export interface AbTest { id?: string; videoId: string; variants: AbVariant[]; winner?: unknown; status?: string }

const n = (v: unknown) => { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0; };

/** Accepte un tableau de tests, un objet { id: test }, ou un test seul. */
export function parseAbTests(raw: unknown): AbTest[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && 'videoId' in raw ? [raw] : typeof raw === 'object' && raw !== null ? Object.values(raw as Record<string, unknown>) : [];
  return list.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { videoId?: unknown }).videoId === 'string').map(t => ({
    id: typeof t.id === 'string' ? t.id : undefined,
    videoId: String(t.videoId), winner: t.winner, status: typeof t.status === 'string' ? t.status : undefined,
    variants: (Array.isArray(t.variants) ? t.variants : []).map((v: unknown) => {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return {
        thumbnailHash: typeof o.thumbnailHash === 'string' ? o.thumbnailHash : undefined,
        title: typeof o.title === 'string' ? o.title : undefined,
        periods: (Array.isArray(o.periods) ? o.periods : []).map((p: unknown) => {
          const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
          return { start: q.start as string | number | undefined, end: q.end as string | number | undefined, impressions: n(q.impressions), ctr: n(q.ctr), views: n(q.views), avgViewDuration: n(q.avgViewDuration) };
        }),
      };
    }),
  }));
}

/** Le CTR est-il exprimé en pourcentage (4,5) plutôt qu'en fraction (0,045) ? */
export const ctrIsPercent = (t: AbTest) => t.variants.some(v => v.periods.some(p => p.ctr > 1));

export interface VariantStats { index: number; label: string; thumbnailHash?: string; title?: string; impressions: number; clicks: number; ctr: number; views: number; avgViewDuration: number; periods: number }
export const variantLetter = (i: number) => String.fromCharCode(65 + (i % 26));

export function variantStats(t: AbTest): VariantStats[] {
  const pctUnit = ctrIsPercent(t);
  return t.variants.map((v, index) => {
    let impressions = 0, clicks = 0, views = 0, dur = 0;
    for (const p of v.periods) {
      const ctr = pctUnit ? p.ctr / 100 : p.ctr;
      impressions += p.impressions; clicks += p.impressions * ctr; views += p.views; dur += p.avgViewDuration * p.views;
    }
    return { index, label: `Version ${variantLetter(index)}`, thumbnailHash: v.thumbnailHash, title: v.title, impressions, clicks, ctr: impressions ? clicks / impressions : 0, views, avgViewDuration: views ? dur / views : 0, periods: v.periods.length };
  });
}

/** Fonction de répartition de la loi normale (approximation d'Abramowitz & Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface Comparison { leader: number; runnerUp: number; lift: number; z: number; confidence: number; significant: boolean }
/** Meneur au CTR et confiance (unilatérale) qu'il batte le second. */
export function compareVariants(stats: VariantStats[]): Comparison | null {
  const ok = stats.filter(s => s.impressions > 0);
  if (ok.length < 2) return null;
  const [a, b] = [...ok].sort((x, y) => y.ctr - x.ctr);
  const p = (a.clicks + b.clicks) / (a.impressions + b.impressions);
  const se = Math.sqrt(p * (1 - p) * (1 / a.impressions + 1 / b.impressions));
  const z = se > 0 ? (a.ctr - b.ctr) / se : 0;
  const confidence = normalCdf(z);
  return { leader: a.index, runnerUp: b.index, lift: b.ctr > 0 ? a.ctr / b.ctr - 1 : 0, z, confidence, significant: confidence >= 0.95 };
}

/** Gagnant déclaré par le module publication (indice, empreinte de miniature, titre ou lettre). */
export function declaredWinner(t: AbTest): number | null {
  const w = t.winner;
  if (w == null || w === '') return null;
  if (typeof w === 'number') return w >= 0 && w < t.variants.length ? w : null;
  if (typeof w === 'object') {
    const o = w as Record<string, unknown>;
    if (typeof o.index === 'number') return o.index;
    if (typeof o.thumbnailHash === 'string') { const i = t.variants.findIndex(v => v.thumbnailHash === o.thumbnailHash); return i >= 0 ? i : null; }
    return null;
  }
  const s = String(w);
  const byHash = t.variants.findIndex(v => v.thumbnailHash === s); if (byHash >= 0) return byHash;
  const byTitle = t.variants.findIndex(v => v.title === s); if (byTitle >= 0) return byTitle;
  if (/^[A-Z]$/i.test(s)) { const i = s.toUpperCase().charCodeAt(0) - 65; return i < t.variants.length ? i : null; }
  return null;
}
