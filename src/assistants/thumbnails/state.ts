// État du miniatureur (zustand) : bibliothèque d'analyses, références, tâche d'analyse en cours
// (elle continue si l'on change d'onglet), passerelles entre onglets (éditeur, analyse, A/B).
import { create } from 'zustand';
import type { EditorDoc } from './editor/model';
import { loadLibrary, loadRefs, saveLibrary, saveRefs } from './lib/store';
import type { NicheSynthesis } from './lib/vision';
import type { Brief, RefEntry, ThumbRecord } from './lib/types';

export type Tab = 'analyse' | 'mur' | 'mine' | 'generateur' | 'editeur' | 'ab';
export type ItemStatus = 'attente' | 'image' | 'mesures' | 'vision' | 'ok' | 'cache' | 'erreur';
export interface JobItem { videoId: string; status: ItemStatus; error?: string }
export interface AnalysisJob {
  id: string; label: string; niche: string; status: 'en cours' | 'terminé' | 'annulé' | 'erreur';
  step: string; items: JobItem[]; error?: string; warnings: string[]; startedAt: number; doneAt?: number;
}
export interface Inbox { blob: Blob; name: string; hash?: string }

interface ThumbState {
  tab: Tab;
  loaded: boolean;
  library: Record<string, ThumbRecord>;
  refs: RefEntry[];
  job: AnalysisJob | null;
  syntheses: Record<string, NicheSynthesis>;
  mineInbox: Inbox | null;                                       // image à analyser (onglet « Ma miniature »)
  editorInbox: { doc?: EditorDoc; image?: Inbox; nonce: number } | null;
  briefInbox: Partial<Brief> | null;                             // pré-remplissage du générateur
  abInbox: Inbox | null;                                         // version à ajouter (onglet A/B)
  wallNiche: string;                                             // niche sélectionnée sur le mur
}
export const useThumbs = create<ThumbState>(() => ({
  tab: 'analyse', loaded: false, library: {}, refs: [], job: null, syntheses: {},
  mineInbox: null, editorInbox: null, briefInbox: null, abInbox: null, wallNiche: '',
}));
export const setTab = (tab: Tab) => useThumbs.setState({ tab });

let loading: Promise<void> | null = null;
export function ensureLoaded(): Promise<void> {
  if (useThumbs.getState().loaded) return Promise.resolve();
  loading ??= (async () => {
    const [library, refs] = await Promise.all([loadLibrary(), loadRefs()]);
    useThumbs.setState(s => ({ library: { ...library, ...s.library }, refs: s.refs.length ? s.refs : refs, loaded: true }));
  })();
  return loading;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savePending: Promise<void> = Promise.resolve();
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; savePending = saveLibrary(useThumbs.getState().library).catch(() => undefined); }, 600);
}
/** Écrit immédiatement la bibliothèque (fin d'analyse). */
export async function flushLibrary() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } await savePending; await saveLibrary(useThumbs.getState().library); }
export function upsertRecords(recs: ThumbRecord[]) {
  if (!recs.length) return;
  useThumbs.setState(s => { const library = { ...s.library }; for (const r of recs) library[r.videoId] = r; return { library }; });
  scheduleSave();
}
export function removeRecords(ids: string[]) {
  useThumbs.setState(s => { const library = { ...s.library }; for (const id of ids) delete library[id]; return { library, refs: s.refs.filter(r => !ids.includes(r.videoId)) }; });
  scheduleSave(); void saveRefs(useThumbs.getState().refs);
}
export const isRef = (videoId: string) => useThumbs.getState().refs.some(r => r.videoId === videoId);
export async function setRef(videoId: string, keep: boolean, patch: Partial<RefEntry> = {}) {
  useThumbs.setState(s => ({ refs: keep ? [{ videoId, addedAt: Date.now(), ...s.refs.find(r => r.videoId === videoId), ...patch }, ...s.refs.filter(r => r.videoId !== videoId)] : s.refs.filter(r => r.videoId !== videoId) }));
  await saveRefs(useThumbs.getState().refs);
}
export const updateJob = (patch: Partial<AnalysisJob> | ((j: AnalysisJob) => Partial<AnalysisJob>)) =>
  useThumbs.setState(s => (s.job ? { job: { ...s.job, ...(typeof patch === 'function' ? patch(s.job) : patch) } } : {}));
export const setItemStatus = (videoId: string, status: ItemStatus, error?: string) =>
  updateJob(j => ({ items: j.items.map(it => (it.videoId === videoId ? { ...it, status, error } : it)) }));

/** Niches connues (étiquettes), triées par nombre de miniatures. */
export function nicheList(library: Record<string, ThumbRecord>): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of Object.values(library)) for (const n of new Set([r.niche, ...(r.niches ?? [])])) if (n) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}
export const inNiche = (r: ThumbRecord, niche: string) => !niche || r.niche === niche || (r.niches ?? []).includes(niche);

// Passerelles entre onglets
export const sendToMine = (inbox: Inbox) => useThumbs.setState({ mineInbox: inbox, tab: 'mine' });
export const sendToEditor = (p: { doc?: EditorDoc; image?: Inbox }) => useThumbs.setState({ editorInbox: { ...p, nonce: Date.now() }, tab: 'editeur' });
export const sendToGenerator = (brief: Partial<Brief>) => useThumbs.setState({ briefInbox: brief, tab: 'generateur' });
export const sendToAb = (inbox: Inbox) => useThumbs.setState({ abInbox: inbox, tab: 'ab' });
