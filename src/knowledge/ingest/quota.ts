// Garde de quota YouTube (pure, testée) : budget par mise à jour + plafond quotidien, mesure réelle si disponible.

export type QuotaKind = 'default' | 'search';
export interface QuotaBucketInfo { id: string; used: number; limit: number; unit?: string }
export interface QuotaReader {
  /** Unités consommées aujourd'hui (bucket général). */
  used: () => Promise<number>;
  /** Buckets détaillés (facultatif). */
  buckets?: () => Promise<{ buckets: QuotaBucketInfo[]; reserve?: number } | null>;
}

/** Coûts estimés (unités du bucket général, doc YouTube Data API v3). */
export const YT_COST = { search: 100, channels: 1, videos: 1, channelVideos: 3, captionsList: 50, captionsDownload: 200 } as const;

export class QuotaExceededError extends Error {
  constructor(label: string, detail: string) { super(`Quota YouTube : ${label} non lancé (${detail}).`); this.name = 'QuotaExceededError'; }
}

export class QuotaGuard {
  /** Unités consommées par cette mise à jour (bucket général). */
  spent = 0;
  searches = 0;
  constructor(private budget: number, private dailyLimit: number, private reader: QuotaReader, private reserveDefault = 500) {}

  private async snapshot() {
    const used = await this.reader.used().catch(() => 0);
    const b = this.reader.buckets ? await this.reader.buckets().catch(() => null) : null;
    return { used, buckets: b?.buckets ?? [], reserve: b?.reserve ?? this.reserveDefault };
  }

  /** Vérifie qu'un appel peut partir ; lève QuotaExceededError sinon. */
  async check(kind: QuotaKind, cost: number, label: string) {
    const snap = await this.snapshot();
    const search = kind === 'search' ? snap.buckets.find(b => b.id === 'search') : undefined;
    if (search) {
      const perCall = /requ|call|appel/i.test(search.unit ?? '') ? 1 : cost;
      if (search.used + perCall > search.limit) throw new QuotaExceededError(label, `quota de recherche du jour épuisé : ${search.used}/${search.limit}`);
      return;
    }
    if (this.spent + cost > this.budget) throw new QuotaExceededError(label, `budget de cette mise à jour atteint : ${this.spent}/${this.budget} unités`);
    const limit = snap.buckets.find(b => b.id === 'default')?.limit ?? this.dailyLimit;
    if (snap.used + cost > limit - snap.reserve) throw new QuotaExceededError(label, `quota quotidien presque épuisé : ${snap.used}/${limit} unités, ${snap.reserve} gardées pour la publication`);
  }

  /** Garde pour un appel fait ailleurs (ex. sous-titres officiels) : vérifie puis compte l'estimation. */
  async guardExternal(cost: number, label: string) { await this.check('default', cost, label); this.spent += cost; }

  /** Exécute un appel YouTube en mesurant sa consommation réelle (estimation si le compteur est indisponible). */
  async run<T>(kind: QuotaKind, cost: number, label: string, fn: () => Promise<T>): Promise<T> {
    await this.check(kind, cost, label);
    const before = await this.reader.used().catch(() => NaN);
    let hasSearchBucket = false;
    if (kind === 'search' && this.reader.buckets) hasSearchBucket = !!(await this.reader.buckets().catch(() => null))?.buckets.some(b => b.id === 'search');
    try { return await fn(); }
    finally {
      const after = await this.reader.used().catch(() => NaN);
      const measured = after - before;
      if (kind === 'search') this.searches++;
      if (Number.isFinite(measured) && measured > 0) this.spent += measured;
      else if (!(kind === 'search' && hasSearchBucket) && !(Number.isFinite(measured) && measured === 0 && before > 0)) this.spent += cost;
    }
  }
}
