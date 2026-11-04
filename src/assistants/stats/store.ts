// État de la vue Stats (vidéo sélectionnée, onglet, curseur partagé entre la courbe et le rapport IA).
import { create } from 'zustand';
import { openView } from '../../ui/appState';
import { parseVideoId } from '../../knowledge/api';
import { repo } from '../../db/store';

export type StatsTab = 'retention' | 'vues' | 'metriques' | 'rapport' | 'comparaison';
interface StatsState {
  videoId: string | null;
  tab: StatsTab;
  /** Curseur épinglé sur la courbe de rétention (secondes). */
  cursor: number | null;
  /** Incrémenté quand on demande de montrer un instant (clic sur un horodatage) : la courbe se recentre. */
  focusToken: number;
  /** Vidéo de référence choisie pour la comparaison. */
  referenceId: string | null;
}
export const useStats = create<StatsState>(() => ({ videoId: null, tab: 'retention', cursor: null, focusToken: 0, referenceId: null }));

export function selectVideo(id: string | null) {
  useStats.setState({ videoId: id, cursor: null, referenceId: null });
  if (id) void repo.kvSet('stats.lastVideo', id).catch(() => undefined);
}
export const setTab = (tab: StatsTab) => useStats.setState({ tab });
export const setCursor = (t: number | null) => useStats.setState({ cursor: t });
export const setReference = (id: string | null) => useStats.setState({ referenceId: id });
/** Positionne le curseur de la courbe à l'instant t et la recentre (horodatage cliquable du rapport IA). */
export const focusMoment = (t: number) => useStats.setState(s => ({ cursor: t, focusToken: s.focusToken + 1 }));
export async function restoreLastVideo() {
  if (useStats.getState().videoId) return;
  const id = await repo.kvGet<string>('stats.lastVideo').catch(() => undefined);
  if (id && !useStats.getState().videoId) useStats.setState({ videoId: id });
}
/** Ouvre la vue Stats sur une vidéo (ID ou URL) — utilisable par les autres modules (Studio, Publication…). */
export function openStatsFor(videoIdOrUrl: string, tab: StatsTab = 'retention'): boolean {
  const id = parseVideoId(videoIdOrUrl);
  if (!id) return false;
  selectVideo(id);
  setTab(tab);
  openView('stats');
  return true;
}
