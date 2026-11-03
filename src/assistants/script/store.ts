// Persistance de l'assistant script : méta des pages Script, réglages, analyses de vidéos, état UI.
import { create } from 'zustand';
import { repo } from '../../db/store';
import { allPages, createPage, getPage, updatePage } from '../../db/pages';
import type { Page } from '../../db/types';
import { DEFAULT_WPM, styleDef, type ScriptStyle } from './method';
import { templateDoc, type JSONNode } from './doc';
import type { VideoAnalysis } from './analysis';

export interface IdeaVerdict { ok: boolean; note: number; pourquoi: string }
export interface IdeaTest {
  idea: string; at: number;
  comprehensible: IdeaVerdict; remarquable: IdeaVerdict;
  verdict: 'go' | 'retravailler' | 'changer';
  concept: string; variantes: string[]; titres: string[]; miniature: string; payoff: string;
}
export interface ClaudeNote { note: number; raison: string }
export type EvalKey = 'hook' | 'promesse' | 'boucles' | 'escalade' | 'rythme' | 'payoff';
export interface AiSuggestion { extrait: string; conseil: string; type: string; principe?: number | null; citation?: string }
export interface ScriptEval {
  hash: string; at: number; global: number;
  notes: Record<EvalKey, ClaudeNote>;
  premierMomentMort?: string | null;
  suggestions: AiSuggestion[];
}
export interface ScriptMeta {
  v: 1;
  idea: string; style: ScriptStyle; targetSec: number; wpm: number;
  plannedTitle: string; plannedThumbnail: string; payoff: string;
  ideaTest?: IdeaTest;
  ignored: string[];
  lastEval?: ScriptEval;
  referenceId?: string;                 // analyse de vidéo de référence
  pending?: { type: 'generate' | 'adapt'; referenceId?: string } | null;
}

export function defaultMeta(style: ScriptStyle = 'gaming'): ScriptMeta {
  return { v: 1, idea: '', style, targetSec: styleDef(style).defaultSec, wpm: DEFAULT_WPM, plannedTitle: '', plannedThumbnail: '', payoff: '', ignored: [] };
}
/** Méta normalisée d'une page Script (valeurs par défaut si la page a été créée ailleurs). */
export function readMeta(page: Page | undefined): ScriptMeta {
  const raw = (page?.meta?.script ?? {}) as Partial<ScriptMeta>;
  const base = defaultMeta((raw.style as ScriptStyle) ?? 'gaming');
  return { ...base, ...raw, v: 1, ignored: Array.isArray(raw.ignored) ? raw.ignored : [], wpm: Number(raw.wpm) || base.wpm, targetSec: Number(raw.targetSec) || base.targetSec };
}
export async function writeMeta(pageId: string, patch: Partial<ScriptMeta>) {
  const page = getPage(pageId);
  if (!page) return;
  const next = { ...readMeta(page), ...patch };
  await updatePage(pageId, { meta: { ...(page.meta ?? {}), script: next } });
}

/** Page parente « Scripts » (créée à la demande) pour ranger les scripts dans l'arborescence. */
export async function ensureScriptsHome(): Promise<string> {
  const found = allPages().find(p => !p.trashed && p.meta?.scriptsHome === true);
  if (found) return found.id;
  const home = await createPage({
    title: 'Scripts', icon: '🎬', kind: 'page', meta: { scriptsHome: true },
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tes scripts YouTube (méthode Squiduu / MrBeast). Crée-en un depuis Assistants → Scripts.' }] }] },
  });
  return home.id;
}

/** Crée une page Script (structure guidée) et renvoie la page. */
export async function createScriptPage(init: { title?: string; meta?: Partial<ScriptMeta>; content?: JSONNode; parentId?: string | null } = {}): Promise<Page> {
  const meta = { ...defaultMeta(init.meta?.style ?? 'gaming'), ...init.meta };
  const parentId = init.parentId !== undefined ? init.parentId : await ensureScriptsHome();
  return createPage({
    title: init.title?.trim() || meta.plannedTitle.trim() || 'Nouveau script', icon: styleDef(meta.style).icon, kind: 'script', parentId,
    content: init.content ?? templateDoc(), meta: { script: meta },
  });
}
export const scriptPages = (pages: Record<string, Page>) =>
  Object.values(pages).filter(p => p.kind === 'script' && !p.trashed).sort((a, b) => b.updatedAt - a.updatedAt);

// ── Réglages ─────────────────────────────────────────────────
export interface ScriptSettings { liveEval: boolean; deadZoneSec: number; evalDelaySec: number }
const SETTINGS_KEY = 'assistants.script.settings';
const DEFAULT_SETTINGS: ScriptSettings = { liveEval: true, deadZoneSec: 35, evalDelaySec: 5 };
export const useScriptSettings = create<ScriptSettings & { loaded: boolean }>(() => ({ ...DEFAULT_SETTINGS, loaded: false }));
export async function loadScriptSettings() {
  if (useScriptSettings.getState().loaded) return;
  const s = await repo.kvGet<Partial<ScriptSettings>>(SETTINGS_KEY).catch(() => undefined);
  useScriptSettings.setState({ ...DEFAULT_SETTINGS, ...(s ?? {}), loaded: true });
}
export async function saveScriptSettings(patch: Partial<ScriptSettings>) {
  const { loaded: _l, ...cur } = useScriptSettings.getState();
  const next = { ...cur, ...patch };
  useScriptSettings.setState(next);
  await repo.kvSet(SETTINGS_KEY, next);
}

// ── Analyses de vidéos (mode « Analyser un script ») ─────────
const ANALYSES_KEY = 'assistants.script.analyses';
export const useAnalyses = create<{ list: VideoAnalysis[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
export async function loadAnalyses(): Promise<VideoAnalysis[]> {
  if (!useAnalyses.getState().loaded) {
    const list = (await repo.kvGet<VideoAnalysis[]>(ANALYSES_KEY).catch(() => undefined)) ?? [];
    useAnalyses.setState({ list, loaded: true });
  }
  return useAnalyses.getState().list;
}
export async function saveAnalysis(a: VideoAnalysis) {
  await loadAnalyses();
  const list = [a, ...useAnalyses.getState().list.filter(x => x.id !== a.id && x.videoId !== a.videoId)].slice(0, 15);
  useAnalyses.setState({ list });
  await repo.kvSet(ANALYSES_KEY, list);
}
export async function deleteAnalysis(id: string) {
  const list = useAnalyses.getState().list.filter(x => x.id !== id);
  useAnalyses.setState({ list });
  await repo.kvSet(ANALYSES_KEY, list);
}
export const getAnalysis = (id: string | undefined) => (id ? useAnalyses.getState().list.find(a => a.id === id) : undefined);

// ── État UI partagé (commandes Ctrl+K → vue Scripts) ─────────
export const useScriptUi = create<{ tab: 'scripts' | 'analyse'; wizard: { open: boolean; referenceId?: string } ; openAnalysisId?: string }>(() => ({ tab: 'scripts', wizard: { open: false } }));
export const openWizard = (referenceId?: string) => useScriptUi.setState({ tab: 'scripts', wizard: { open: true, referenceId } });
