// Cache local (repo kv) : en-têtes par compte/dossier, corps des messages ouverts (lecture
// hors-ligne), tri Claude, résumés, brouillons, réglages. Écritures regroupées (debounce).
import { repo } from '../db/store';
import type { FolderCache, LocalDraft, MailBody, MailSettings, StyleProfile, TriageResult } from './types';
import { DEFAULT_CATEGORIES } from './categories';

const MAX_HEADERS = 600;
const MAX_BODIES = 400;
const MAX_TRIAGE = 8000;
const MAX_INLINE_DATA = 400_000;

async function kvGet<T>(k: string): Promise<T | undefined> {
  try { const v = await repo.kvGet<T | null>(k); return v ?? undefined; } catch { return undefined; }
}
async function kvSet(k: string, v: unknown) {
  try { await repo.kvSet(k, v); } catch (e) { console.warn('[mail] cache non enregistré', k, e); }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, unknown>();
function later(k: string, v: unknown, ms = 600) {
  pending.set(k, v);
  const t = timers.get(k); if (t) clearTimeout(t);
  timers.set(k, setTimeout(() => { timers.delete(k); const val = pending.get(k); pending.delete(k); void kvSet(k, val); }, ms));
}
/** Écrit immédiatement tout ce qui est en attente (fermeture de l'app). */
export async function flushCache() {
  for (const [k, t] of timers) { clearTimeout(t); timers.delete(k); const v = pending.get(k); pending.delete(k); await kvSet(k, v); }
}

// ── En-têtes ──
const folderKey = (accountId: string, folderId: string) => `mail.cache.${accountId}.${encodeURIComponent(folderId)}`;
export const loadFolderCache = (accountId: string, folderId: string) => kvGet<FolderCache>(folderKey(accountId, folderId));
export function saveFolderCache(accountId: string, folderId: string, c: FolderCache) {
  const headers = c.headers.length > MAX_HEADERS ? [...c.headers].sort((a, b) => b.date - a.date).slice(0, MAX_HEADERS) : c.headers;
  later(folderKey(accountId, folderId), { headers, sync: c.sync });
}
export const clearFolderCache = (accountId: string, folderId: string) => kvSet(folderKey(accountId, folderId), null);

// ── Corps (LRU) ──
const bodyKey = (key: string) => `mail.body.${key}`;
let bodyIndex: string[] | null = null;
export const loadBody = (key: string) => kvGet<MailBody>(bodyKey(key));
export async function saveBody(b: MailBody) {
  const slim: MailBody = { ...b, attachments: b.attachments.map(a => (a.data && (!a.inline || a.data.length > MAX_INLINE_DATA) ? { ...a, data: undefined } : a)) };
  await kvSet(bodyKey(b.key), slim);
  bodyIndex ??= (await kvGet<string[]>('mail.bodyIndex')) ?? [];
  bodyIndex = [b.key, ...bodyIndex.filter(k => k !== b.key)];
  const evicted = bodyIndex.slice(MAX_BODIES); bodyIndex = bodyIndex.slice(0, MAX_BODIES);
  for (const k of evicted) await kvSet(bodyKey(k), null);
  later('mail.bodyIndex', bodyIndex, 1500);
}
export async function dropAccountBodies(accountId: string) {
  bodyIndex ??= (await kvGet<string[]>('mail.bodyIndex')) ?? [];
  const mine = bodyIndex.filter(k => k.startsWith(accountId + '|'));
  for (const k of mine) await kvSet(bodyKey(k), null);
  bodyIndex = bodyIndex.filter(k => !k.startsWith(accountId + '|'));
  await kvSet('mail.bodyIndex', bodyIndex);
}

// ── Tri Claude (par Message-ID) ──
export const loadTriage = async () => (await kvGet<Record<string, TriageResult>>('mail.triage')) ?? {};
export function saveTriage(map: Record<string, TriageResult>) {
  const entries = Object.entries(map);
  const kept = entries.length > MAX_TRIAGE ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TRIAGE)) : map;
  later('mail.triage', kept, 1200);
}

// ── Résumés de fils ──
export interface SummaryEntry { text: string; at: number; lastKey: string }
export const loadSummaries = async () => (await kvGet<Record<string, SummaryEntry>>('mail.summaries')) ?? {};
export const saveSummaries = (m: Record<string, SummaryEntry>) => {
  const e = Object.entries(m); later('mail.summaries', e.length > 500 ? Object.fromEntries(e.sort((a, b) => b[1].at - a[1].at).slice(0, 500)) : m, 1000);
};

// ── Liens mail → pages créées ──
export interface MailLinks { pageId?: string; partnerRowId?: string; taskRowId?: string }
export const loadLinks = async () => (await kvGet<Record<string, MailLinks>>('mail.links')) ?? {};
export const saveLinks = (m: Record<string, MailLinks>) => later('mail.links', m, 300);

// ── Ton (profil d'écriture appris) ──
export const loadStyle = (accountId: string) => kvGet<StyleProfile>(`mail.style.${accountId}`);
export const saveStyle = (accountId: string, p: StyleProfile | null) => kvSet(`mail.style.${accountId}`, p);

// ── Brouillons locaux ──
export const loadDrafts = async () => (await kvGet<LocalDraft[]>('mail.drafts')) ?? [];
export const saveDrafts = (d: LocalDraft[]) => later('mail.drafts', d, 400);

// ── Réglages ──
export const DEFAULT_SETTINGS: MailSettings = {
  syncIntervalMin: 3, notifyUrgent: true, notifyAll: false, autoTriage: true, showRemoteImages: false,
  trustedSenders: [], categories: DEFAULT_CATEGORIES, toneNotes: '',
};
export async function loadSettings(): Promise<MailSettings> {
  const s = await kvGet<Partial<MailSettings>>('mail.settings');
  const merged = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  if (!Array.isArray(merged.categories) || !merged.categories.length) merged.categories = DEFAULT_CATEGORIES;
  return merged;
}
export const saveSettings = (s: MailSettings) => kvSet('mail.settings', s);
