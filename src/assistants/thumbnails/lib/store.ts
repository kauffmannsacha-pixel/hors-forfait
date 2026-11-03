// Persistance kv du miniatureur.
import { repo } from '../../../db/store';
import type { ConceptBatch, MyAnalysis, RefEntry, ThumbRecord, ThumbVersion, VersionIndexEntry } from './types';

export const KV = {
  library: 'thumb:library',            // Record<videoId, ThumbRecord> — analyses en cache
  refs: 'thumb:refs',                  // RefEntry[] — « Garder comme référence »
  channels: 'thumb:channels',          // Record<channelId, ChannelStat>
  concepts: 'thumb:concepts',          // ConceptBatch[] — historique du générateur
  mine: 'thumb:mine',                  // MyAnalysis[] — historique de mes analyses
  editor: 'thumb:editor',              // EditorDoc — document en cours (autosauvegarde)
  versionsIndex: 'thumb:versions:index',
  versions: (videoId: string) => `thumb:versions:${videoId}`,
  abtests: 'abtests',                  // écrit par le module publication (lecture seule ici)
} as const;

export interface ChannelStat { title: string; subscribers?: number; fetchedAt: number }

const get = async <T>(k: string, d: T): Promise<T> => { try { return (await repo.kvGet<T>(k)) ?? d; } catch { return d; } };
export const loadLibrary = () => get<Record<string, ThumbRecord>>(KV.library, {});
export const saveLibrary = (lib: Record<string, ThumbRecord>) => repo.kvSet(KV.library, lib);
export const loadRefs = () => get<RefEntry[]>(KV.refs, []);
export const saveRefs = (r: RefEntry[]) => repo.kvSet(KV.refs, r);
export const loadChannelStats = () => get<Record<string, ChannelStat>>(KV.channels, {});
export const saveChannelStats = (c: Record<string, ChannelStat>) => repo.kvSet(KV.channels, c);
export const loadConcepts = () => get<ConceptBatch[]>(KV.concepts, []);
export const saveConcepts = (c: ConceptBatch[]) => repo.kvSet(KV.concepts, c.slice(0, 30));
export const loadMine = () => get<MyAnalysis[]>(KV.mine, []);
export const saveMine = (m: MyAnalysis[]) => repo.kvSet(KV.mine, m.slice(0, 40));

export const loadVersions = (videoId: string) => get<ThumbVersion[]>(KV.versions(videoId), []);
export async function saveVersions(videoId: string, title: string, v: ThumbVersion[]) {
  await repo.kvSet(KV.versions(videoId), v);
  const idx = await get<VersionIndexEntry[]>(KV.versionsIndex, []);
  const next = [{ videoId, title, updatedAt: Date.now() }, ...idx.filter(e => e.videoId !== videoId)];
  await repo.kvSet(KV.versionsIndex, v.length ? next : next.filter(e => e.videoId !== videoId));
}
export const loadVersionsIndex = () => get<VersionIndexEntry[]>(KV.versionsIndex, []);
export const loadAbTestsRaw = () => get<unknown>(KV.abtests, undefined);
