// Fusion hybride (pure, testée) : similarité cosinus (sens) + BM25 (mots-clés), repli mots-clés seuls.

/** Cosinus jugé « sans rapport » / « très proche » pour le modèle paraphrase-multilingual-MiniLM. */
export const COS_FLOOR = 0.2;
export const COS_CEIL = 0.8;

export interface FuseOptions { alpha?: number; minScore?: number }
export interface Scored { id: string; score: number; semantic?: number; keyword?: number }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * kw : scores BM25 (positifs, plus grand = mieux), normalisés par le max.
 * cos : cosinus par id (null = modèle non chargé → mots-clés seuls).
 * score = alpha·sémantique + (1−alpha)·mots-clés.
 */
export function fuseScores(kw: Map<string, number>, cos: Map<string, number> | null, opts: FuseOptions = {}): Scored[] {
  const alpha = opts.alpha ?? 0.6, minScore = opts.minScore ?? 0.08;
  let maxKw = 0; for (const v of kw.values()) if (v > maxKw) maxKw = v;
  const out: Scored[] = [];
  if (!cos || !cos.size) {
    for (const [id, v] of kw) if (v > 0 && maxKw > 0) out.push({ id, score: v / maxKw, keyword: v / maxKw });
  } else {
    const ids = new Set<string>([...kw.keys(), ...cos.keys()]);
    for (const id of ids) {
      const k = maxKw > 0 ? (kw.get(id) ?? 0) / maxKw : 0;
      const c = cos.get(id);
      const s = c == null ? 0 : clamp01((c - COS_FLOOR) / (COS_CEIL - COS_FLOOR));
      const score = alpha * s + (1 - alpha) * k;
      if (score >= minScore) out.push({ id, score, semantic: s, keyword: k });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
