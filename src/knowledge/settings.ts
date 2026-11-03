// Réglages de la base de connaissances (kv) + valeurs par défaut.
import { create } from 'zustand';
import { repo, uid } from '../db/store';
import type { CreatorConfig, KnSettings, TopicQuery } from './types';
import { DEFAULT_MODEL } from './embed/client';

export const KV = {
  settings: 'knowledge.settings',
  lastUpdate: 'knowledge.lastUpdate',
  lastAttempt: 'knowledge.lastAttempt',
  lastCheck: 'knowledge.lastAutoCheck',
  lastReport: 'knowledge.lastReport',
  seedVersion: 'knowledge.seedVersion',
  seedDeleted: 'knowledge.seedDeleted',
  modelReadyOnce: 'knowledge.modelReadyOnce',
} as const;

/** Créateurs suivis par défaut. Les IDs de chaîne fournis ont été vérifiés (API) ; les autres sont résolus par @handle ou recherche. */
export const DEFAULT_CREATORS: Omit<CreatorConfig, 'id'>[] = [
  { name: 'MrBeast', handle: '@MrBeast', enabled: true },
  { name: 'Paddy Galloway', channelId: 'UClga3ybuyyjpvqsh-cf3DvQ', enabled: true },
  { name: 'Colin and Samir', channelId: 'UCamLstJyCa-t5gfZegxsFMw', enabled: true },
  { name: 'Ali Abdaal', handle: '@aliabdaal', enabled: true },
  { name: 'Veritasium', channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA', enabled: true },
  { name: 'Film Booth', channelId: 'UCSQ6ebJE6MTrEAN_P-L-fuA', enabled: true },
  { name: 'Think Media', handle: '@ThinkMediaTV', enabled: true },
  { name: 'Creator Booth', enabled: true },
  { name: 'Squiduu', enabled: true },
];

export const DEFAULT_QUERIES: Omit<TopicQuery, 'id'>[] = [
  { topic: 'script', query: 'how to write a youtube script retention storytelling', enabled: true },
  { topic: 'retention', query: 'youtube audience retention tips', enabled: true },
  { topic: 'hook', query: 'youtube video hook first 30 seconds', enabled: true },
  { topic: 'thumbnail', query: 'youtube thumbnail strategy tips', enabled: true },
  { topic: 'title', query: 'youtube title tips clickbait', enabled: true },
  { topic: 'packaging', query: 'youtube packaging title thumbnail idea', enabled: true },
  { topic: 'script', query: 'écrire un script youtube rétention', enabled: false },
];

export const defaultSettings = (): KnSettings => ({
  autoUpdate: true,
  creators: DEFAULT_CREATORS.map(c => ({ ...c, id: uid() })),
  queries: DEFAULT_QUERIES.map(q => ({ ...q, id: uid() })),
  maxVideosPerUpdate: 10,
  videosPerCreator: 15,
  resultsPerQuery: 8,
  quotaBudget: 2000,
  dailyQuota: 10000,
  minViews: 50000,
  minDurationSec: 180,
  maxMinutesPerVideo: 45,
  onlyFollowed: false,
  semantic: true,
  model: DEFAULT_MODEL,
});

export const useKnSettings = create<{ settings: KnSettings | null }>(() => ({ settings: null }));

let loadPromise: Promise<KnSettings> | null = null;
export function getSettings(): Promise<KnSettings> {
  const cur = useKnSettings.getState().settings;
  if (cur) return Promise.resolve(cur);
  if (!loadPromise) {
    loadPromise = repo.kvGet<Partial<KnSettings>>(KV.settings).catch(() => undefined).then(saved => {
      const s: KnSettings = { ...defaultSettings(), ...(saved ?? {}) };
      if (!Array.isArray(s.creators)) s.creators = defaultSettings().creators;
      if (!Array.isArray(s.queries)) s.queries = defaultSettings().queries;
      useKnSettings.setState({ settings: s });
      return s;
    });
  }
  return loadPromise;
}

export async function saveSettings(patch: Partial<KnSettings>): Promise<KnSettings> {
  const s = { ...(await getSettings()), ...patch };
  useKnSettings.setState({ settings: s });
  await repo.kvSet(KV.settings, s);
  return s;
}

/** Interprète « @handle », une URL de chaîne, un ID « UC… » ou un nom. */
export function parseChannelInput(input: string): { channelId?: string; handle?: string; name?: string } {
  const s = input.trim();
  const id = /(?:channel\/)?(UC[\w-]{22})\b/.exec(s)?.[1];
  if (id) return { channelId: id };
  const h = /(?:youtube\.com\/)?@([\w.-]{3,30})/.exec(s)?.[1];
  if (h) return { handle: '@' + h };
  return s ? { name: s } : {};
}
