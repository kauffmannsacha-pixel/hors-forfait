// CONTRAT scores (utilisé par la checklist de publication et le Studio).
export interface ScoreResult { score: number /* /10 */; reasons: string[]; citations?: string[] }
type Impl = {
  scoreTitle: (title: string, ctx?: { niche?: string; thumbnailText?: string; lang?: 'fr' | 'en' }) => Promise<ScoreResult>;
  scoreThumbnail: (image: { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | { url: string }, ctx?: { title?: string; niche?: string }) => Promise<ScoreResult>;
  scoreHook: (scriptOrHookText: string) => Promise<ScoreResult>;
};
const missing = (n: string) => async (): Promise<never> => { throw new Error(`Assistant ${n} indisponible`); };
const impl: Impl = { scoreTitle: missing('titres'), scoreThumbnail: missing('miniatures'), scoreHook: missing('script') };
export const setScoreImpl = (p: Partial<Impl>) => { Object.assign(impl, p); };
export const scoreTitle: Impl['scoreTitle'] = (...a) => impl.scoreTitle(...a);
export const scoreThumbnail: Impl['scoreThumbnail'] = (...a) => impl.scoreThumbnail(...a);
export const scoreHook: Impl['scoreHook'] = (...a) => impl.scoreHook(...a);
