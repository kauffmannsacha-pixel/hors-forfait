// Capacités des modèles Claude (pur, sans dépendance) : réflexion adaptative, effort, affichage
// des progrès, recherche d'outils… Source principale : l'API Models (capabilities) ; à défaut,
// déduction prudente depuis l'identifiant du modèle.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_LABELS: Record<Effort, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximum' };

export type ModelLine = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

export interface ModelCaps {
  id: string;
  displayName: string;
  line: ModelLine | null;
  createdAt?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
  /** thinking: {type:'adaptive'} accepté */
  adaptive: boolean;
  /** niveaux d'effort acceptés (null = paramètre effort non supporté) */
  efforts: Effort[] | null;
  /** thinking.display = 'updates' (notes de progression entre les appels d'outils) */
  updatesDisplay: boolean;
  /** outil de recherche d'outils (tool search) */
  toolSearch: boolean;
  vision: boolean;
  pdf: boolean;
  maxOutput?: number;
  contextWindow?: number;
}

/** Sous-ensemble de ModelInfo (API Models) utilisé ici, pour rester testable sans le SDK. */
export interface ModelInfoLike {
  id: string;
  display_name?: string;
  created_at?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
  line?: ModelLine | null;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  capabilities?: {
    thinking?: { supported?: boolean; types?: { adaptive?: { supported?: boolean } | null } | null } | null;
    effort?: ({ supported?: boolean } & Partial<Record<Effort, { supported?: boolean } | null>>) | null;
    image_input?: { supported?: boolean } | null;
    pdf_input?: { supported?: boolean } | null;
  } | null;
}

/** « claude-opus-5-5 » → { line: 'opus', version: 5.5 } ; « claude-sonnet-4-5-20250929 » → 4.5. */
export function parseModelId(id: string): { line: ModelLine | null; version: number | null } {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$|@)/.exec(id.toLowerCase());
  if (m) return { line: m[1] as ModelLine, version: Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) };
  // Anciens identifiants : claude-3-5-sonnet-20241022, claude-3-opus-…
  const old = /^claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)/.exec(id.toLowerCase());
  if (old) return { line: old[3] as ModelLine, version: Number(old[1]) + (old[2] ? Number(old[2]) / 10 : 0) };
  return { line: null, version: null };
}

const atLeast = (v: number | null, min: number) => v != null && v >= min - 1e-9;

/** Déduction prudente des capacités depuis l'identifiant (quand l'API Models n'est pas disponible). */
export function guessCaps(id: string): ModelCaps {
  const { line, version } = parseModelId(id);
  const big = line === 'fable' || line === 'mythos';
  const adaptive = big || (line === 'opus' && atLeast(version, 4.6)) || (line === 'sonnet' && atLeast(version, 4.6)) || (line === 'haiku' && atLeast(version, 5));
  let efforts: Effort[] | null = null;
  if (big || (line === 'opus' && atLeast(version, 4.7)) || (line === 'sonnet' && atLeast(version, 5)) || (line === 'haiku' && atLeast(version, 5.5))) efforts = [...EFFORTS];
  else if ((line === 'opus' && atLeast(version, 4.6)) || (line === 'sonnet' && atLeast(version, 4.6))) efforts = ['low', 'medium', 'high', 'max'];
  else if (line === 'opus' && atLeast(version, 4.5)) efforts = ['low', 'medium', 'high'];
  const updatesDisplay = big || (line === 'opus' && atLeast(version, 5.5)) || (line === 'sonnet' && atLeast(version, 5.5));
  const toolSearch = big || ((line === 'opus' || line === 'sonnet') && atLeast(version, 4.5));
  const modern = big || atLeast(version, 4);
  return {
    id, displayName: prettyModelName(id), line, adaptive, efforts, updatesDisplay, toolSearch,
    vision: true, pdf: true,
    maxOutput: modern ? (line === 'haiku' && !atLeast(version, 5) ? 64000 : 128000) : 8192,
    contextWindow: modern ? (line === 'haiku' && !atLeast(version, 5) ? 200000 : 1000000) : 200000,
  };
}

/** Capacités à partir d'un objet de l'API Models (avec repli sur la déduction). */
export function capsFromModelInfo(m: ModelInfoLike): ModelCaps {
  const g = guessCaps(m.id);
  const c = m.capabilities;
  const effortCap = c?.effort;
  const efforts = effortCap
    ? (effortCap.supported ? EFFORTS.filter(e => effortCap[e]?.supported) : null)
    : g.efforts;
  return {
    ...g,
    displayName: m.display_name || g.displayName,
    line: m.line ?? g.line,
    createdAt: m.created_at,
    lifecycle: m.lifecycle,
    adaptive: c?.thinking ? !!(c.thinking.supported && c.thinking.types?.adaptive?.supported) : g.adaptive,
    efforts: efforts && efforts.length ? efforts : null,
    vision: c?.image_input ? !!c.image_input.supported : g.vision,
    pdf: c?.pdf_input ? !!c.pdf_input.supported : g.pdf,
    maxOutput: m.max_tokens ?? g.maxOutput,
    contextWindow: m.max_input_tokens ?? g.contextWindow,
  };
}

/** Le plus récent Claude Opus actif (date de création décroissante, puis version). */
export function pickLatestOpus(models: Pick<ModelCaps, 'id' | 'line' | 'createdAt' | 'lifecycle'>[]): string | null {
  const opus = models.filter(m => (m.line ?? parseModelId(m.id).line) === 'opus' && (m.lifecycle ?? 'active') === 'active');
  if (!opus.length) return null;
  opus.sort((a, b) => {
    const da = a.createdAt ? Date.parse(a.createdAt) : 0; const db = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (db !== da) return db - da;
    return (parseModelId(b.id).version ?? 0) - (parseModelId(a.id).version ?? 0);
  });
  return opus[0].id;
}

/** « claude-opus-5-5 » → « Claude Opus 5.5 ». */
export function prettyModelName(id: string): string {
  const { line, version } = parseModelId(id);
  if (!line) return id;
  const name = line.charAt(0).toUpperCase() + line.slice(1);
  return `Claude ${name}${version != null ? ' ' + (Number.isInteger(version) ? version : version.toFixed(1)) : ''}`;
}

/** Paramètres de réflexion / effort pour une requête Messages (API bêta). */
export function requestTuning(caps: ModelCaps, effort: Effort | 'auto') {
  const betas: string[] = [];
  let thinking: { type: 'adaptive'; display: 'updates' | 'summarized'; block_binding: { prefix_mismatch_behavior: 'drop_block' } } | undefined;
  if (caps.adaptive) {
    const display = caps.updatesDisplay ? 'updates' : 'summarized';
    if (display === 'updates') betas.push('thinking-display-updates-2026-08-18');
    // Historique en ajout seul ; si la liste d'outils change (serveur MCP connecté entre deux messages),
    // l'API abandonne les blocs de réflexion invalidés au lieu de refuser la requête.
    betas.push('thinking-binding-controls-2026-08-01');
    thinking = { type: 'adaptive', display, block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  }
  const level = effort === 'auto' ? null : (caps.efforts?.includes(effort) ? effort : null);
  return { betas, thinking, effort: level };
}
