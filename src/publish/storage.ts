// Persistance kv du module Publication (brouillon, templates, liens auto, historique des publications).
import { create } from 'zustand';
import { repo, uid } from '../db/store';
import { DEFAULT_TEMPLATES, type DescriptionTemplate } from './metadata';
import type { LinkItem, PublishedVideo, VideoDraft } from './types';

export const K = {
  queue: 'publish:queue', draft: 'publish:draft', history: 'publish:history', templates: 'publish:templates',
  links: 'publish:links', prefs: 'publish:prefs', abtests: 'abtests',
} as const;

export interface PublishPrefs { lastChannelId?: string; categoryId?: string; defaultLanguage?: string; defaultAudioLanguage?: string; templateId?: string }

export function emptyDraft(prefs: PublishPrefs = {}, channelId = ''): VideoDraft {
  const tpl = DEFAULT_TEMPLATES.find(t => t.id === prefs.templateId) ?? DEFAULT_TEMPLATES[0];
  return {
    id: uid(), channelId: channelId || prefs.lastChannelId || '', title: '', description: tpl.body, templateId: tpl.id,
    includeChapters: true, includeLinks: true, chapters: [], tags: [], categoryId: prefs.categoryId ?? '24',
    defaultLanguage: prefs.defaultLanguage ?? 'fr', defaultAudioLanguage: prefs.defaultAudioLanguage ?? 'fr',
    captions: [], playlistIds: [], privacy: 'private', madeForKids: null, containsSyntheticMedia: false, license: 'youtube',
    embeddable: true, publicStatsViewable: true, notifySubscribers: true, updatedAt: Date.now(),
  };
}

export const loadDraft = () => repo.kvGet<VideoDraft>(K.draft);
let draftTimer: ReturnType<typeof setTimeout> | null = null;
/** Sauvegarde différée du brouillon (survit au redémarrage). */
export function saveDraftSoon(d: VideoDraft | null) {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { void repo.kvSet(K.draft, d); }, 400);
}

export const loadPrefs = async () => (await repo.kvGet<PublishPrefs>(K.prefs)) ?? {};
export const savePrefs = async (p: Partial<PublishPrefs>) => repo.kvSet(K.prefs, { ...(await loadPrefs()), ...p });

export async function loadTemplates(): Promise<DescriptionTemplate[]> {
  const t = await repo.kvGet<DescriptionTemplate[]>(K.templates);
  return t?.length ? t : DEFAULT_TEMPLATES;
}
export const saveTemplates = (t: DescriptionTemplate[]) => repo.kvSet(K.templates, t);

export async function loadLinks(channelId: string): Promise<LinkItem[]> {
  const all = (await repo.kvGet<Record<string, LinkItem[]>>(K.links)) ?? {};
  return all[channelId] ?? [];
}
export async function saveLinks(channelId: string, links: LinkItem[]) {
  const all = (await repo.kvGet<Record<string, LinkItem[]>>(K.links)) ?? {};
  await repo.kvSet(K.links, { ...all, [channelId]: links });
}

// ── Historique des publications (Studio : calendrier ; instantanés de stats) ──
export const useHistory = create<{ items: PublishedVideo[]; loaded: boolean }>(() => ({ items: [], loaded: false }));
export async function loadHistory(): Promise<PublishedVideo[]> {
  if (!useHistory.getState().loaded) useHistory.setState({ items: (await repo.kvGet<PublishedVideo[]>(K.history)) ?? [], loaded: true });
  return useHistory.getState().items;
}
export async function recordPublished(v: PublishedVideo) {
  await loadHistory();
  const items = [v, ...useHistory.getState().items.filter(x => x.videoId !== v.videoId)].slice(0, 500);
  useHistory.setState({ items });
  await repo.kvSet(K.history, items);
}

// ── Navigation interne (onglet, carte à publier, créneau choisi) ──
export type PublishTab = 'preparer' | 'file' | 'ab' | 'heure';
export const usePublishNav = create<{ tab: PublishTab; pendingIdeaId?: string; pendingSchedule?: number }>(() => ({ tab: 'preparer' }));
export const goPublishTab = (tab: PublishTab) => usePublishNav.setState({ tab });
