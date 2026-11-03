// Impressions et CTR des miniatures : ABSENTS de l'API YouTube Analytics (requêtes ciblées), mais publiés depuis
// le 15 janvier 2026 par l'API YouTube Reporting (rapports groupés « reach ») :
//   type de rapport channel_reach_basic_a1 — colonnes date, channel_id, video_id,
//   video_thumbnail_impressions, video_thumbnail_impressions_ctr.
// Fonctionnement : il faut créer une tâche (job) de rapport une fois ; YouTube génère ensuite un CSV par jour
// (premier rapport sous 48 h, + 30 jours d'historique générés à la création ; rapports conservés 60 jours).
// Endpoints : https://youtubereporting.googleapis.com/v1/jobs , /v1/jobs/{id}/reports , puis downloadUrl.
import { youtube } from '../../../connectors/api';
import { httpError, httpFetch } from '../../../db/http';
import { repo } from '../../../db/store';
import { confirmAction } from '../../../ui/appState';
import { parseCSV } from '../lib/csv';
import { cached, HOUR, MIN } from './cache';

const BASE = 'https://youtubereporting.googleapis.com/v1';
export const REACH_REPORT_TYPE = 'channel_reach_basic_a1';
const JOB_KEY = (ch: string) => `stats.reach.job.${ch}`;
const REPORT_KEY = (id: string) => `stats.reach.report.${id}`;
const MAX_DOWNLOADS = 70;

interface Job { id: string; reportTypeId: string; name?: string; createTime?: string; systemManaged?: boolean }
interface Report { id: string; startTime: string; endTime: string; createTime: string; downloadUrl: string }
/** Rapport analysé : date (AAAA-MM-JJ) + par vidéo [impressions, CTR en ratio 0–1]. */
interface ParsedReport { date: string; byVideo: Record<string, [number, number | null]> }

export interface ReachDay { date: string; impressions: number; ctr: number | null }
export type ReachStatus =
  | { state: 'no-job' }
  | { state: 'pending'; since: string }
  | { state: 'ready'; days: ReachDay[]; impressions: number; ctr: number | null; reports: number; firstDay: string | null; lastDay: string | null };

async function call<T>(channelId: string, url: string, init: RequestInit = {}): Promise<T> {
  const token = await youtube.token(channelId);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body) headers['Content-Type'] = 'application/json';
  const r = await httpFetch(url, { ...init, headers });
  if (!r.ok) throw await httpError('YouTube Reporting', r);
  return (await r.json()) as T;
}

/** Cherche la tâche « reach » de la chaîne (mémorisée en kv). */
export async function findReachJob(channelId: string, force = false): Promise<Job | null> {
  if (!force) {
    const known = await repo.kvGet<Job>(JOB_KEY(channelId)).catch(() => undefined);
    if (known?.id) return known;
  }
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await call<{ jobs?: Job[]; nextPageToken?: string }>(channelId, `${BASE}/jobs?${q}`);
    const job = res.jobs?.find(j => j.reportTypeId === REACH_REPORT_TYPE);
    if (job) { await repo.kvSet(JOB_KEY(channelId), job).catch(() => undefined); return job; }
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return null;
}

/** Crée la tâche de rapport (action sur le compte YouTube : confirmation obligatoire). */
export async function enableReach(channelId: string): Promise<Job | null> {
  const ok = await confirmAction(
    'Activer le suivi des impressions et du CTR ?\n\nPrisme va créer, sur ta chaîne YouTube, une tâche de rapport en lecture seule (API YouTube Reporting, rapport « reach »). YouTube produit ensuite un rapport par jour : les premiers chiffres arrivent sous 48 h, avec 30 jours d’historique.',
    { confirmLabel: 'Activer' },
  );
  if (!ok) return null;
  const existing = await findReachJob(channelId, true);
  if (existing) return existing;
  const job = await call<Job>(channelId, `${BASE}/jobs`, { method: 'POST', body: JSON.stringify({ reportTypeId: REACH_REPORT_TYPE, name: 'Prisme — impressions et CTR des miniatures' }) });
  await repo.kvSet(JOB_KEY(channelId), job).catch(() => undefined);
  return job;
}

/** Normalise le CTR : la doc parle de « pourcentage » mais le définit comme clics / impressions → on détecte l'échelle. */
export function normalizeCtr(values: number[]): (v: number) => number {
  const percent = values.some(v => v > 1);
  return (v: number) => (percent ? v / 100 : v);
}

/** Analyse le CSV d'un rapport reach (toutes les vidéos de la chaîne pour une journée). */
export function parseReachCsv(text: string, fallbackDate: string): ParsedReport {
  const rows = parseCSV(text);
  const head = (rows[0] ?? []).map(h => h.trim().toLowerCase());
  const iV = head.indexOf('video_id'), iI = head.indexOf('video_thumbnail_impressions'), iC = head.indexOf('video_thumbnail_impressions_ctr'), iD = head.indexOf('date');
  const byVideo: Record<string, [number, number | null]> = {};
  if (iV < 0 || iI < 0) return { date: fallbackDate, byVideo };
  const body = rows.slice(1).filter(r => r.length > Math.max(iV, iI));
  const ctrs = iC >= 0 ? body.map(r => Number(r[iC])).filter(Number.isFinite) : [];
  const norm = normalizeCtr(ctrs);
  let date = fallbackDate;
  for (const r of body) {
    const id = r[iV];
    const impr = Number(r[iI]);
    if (!id || !Number.isFinite(impr)) continue;
    const c = iC >= 0 && r[iC] !== '' && Number.isFinite(Number(r[iC])) ? norm(Number(r[iC])) : null;
    // Plusieurs lignes possibles pour une vidéo : cumul des impressions, CTR pondéré.
    const prev = byVideo[id];
    if (prev) {
      const tot = prev[0] + impr;
      const ctr = prev[1] != null && c != null && tot > 0 ? (prev[1] * prev[0] + c * impr) / tot : prev[1] ?? c;
      byVideo[id] = [tot, ctr];
    } else byVideo[id] = [impr, c];
    if (iD >= 0 && /^\d{8}$/.test(r[iD] ?? '')) date = `${r[iD].slice(0, 4)}-${r[iD].slice(4, 6)}-${r[iD].slice(6, 8)}`;
  }
  return { date, byVideo };
}

async function loadReport(channelId: string, rep: Report): Promise<ParsedReport> {
  const known = await repo.kvGet<ParsedReport>(REPORT_KEY(rep.id)).catch(() => undefined);
  if (known?.byVideo) return known;
  const token = await youtube.token(channelId);
  const r = await httpFetch(rep.downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw await httpError('YouTube Reporting', r);
  const parsed = parseReachCsv(await r.text(), rep.startTime.slice(0, 10));
  await repo.kvSet(REPORT_KEY(rep.id), parsed).catch(() => undefined);
  return parsed;
}

/** Impressions et CTR d'une vidéo depuis sa publication (rapports quotidiens disponibles). */
export function reachForVideo(channelId: string, videoId: string, publishedAt: string, force = false) {
  return cached(`reach.${videoId}`, 6 * HOUR, async (): Promise<ReachStatus> => {
    const job = await findReachJob(channelId, force);
    if (!job) return { state: 'no-job' };
    const since = new Date(new Date(publishedAt).getTime() - 86_400_000);
    const list: Report[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ pageSize: '100', startTimeAtOrAfter: since.toISOString() });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await call<{ reports?: Report[]; nextPageToken?: string }>(channelId, `${BASE}/jobs/${encodeURIComponent(job.id)}/reports?${q}`);
      list.push(...(res.reports ?? []));
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    if (!list.length) return { state: 'pending', since: job.createTime ?? new Date().toISOString() };
    // Un même jour peut être republié (correction) : on garde la version la plus récente.
    const byDay = new Map<string, Report>();
    for (const r of list) {
      const cur = byDay.get(r.startTime);
      if (!cur || r.createTime > cur.createTime) byDay.set(r.startTime, r);
    }
    const reports = [...byDay.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(-MAX_DOWNLOADS);
    const days: ReachDay[] = [];
    for (const rep of reports) {
      const p = await loadReport(channelId, rep);
      const v = p.byVideo[videoId];
      if (v) days.push({ date: p.date, impressions: v[0], ctr: v[1] });
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    const impressions = days.reduce((n, d) => n + d.impressions, 0);
    const withCtr = days.filter(d => d.ctr != null && d.impressions > 0);
    const w = withCtr.reduce((n, d) => n + d.impressions, 0);
    const ctr = w > 0 ? withCtr.reduce((n, d) => n + (d.ctr as number) * d.impressions, 0) / w : null;
    return { state: 'ready', days, impressions, ctr, reports: reports.length, firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null };
  }, { force, persist: true });
}

/** Statut léger (sans téléchargement) pour l'affichage initial. */
export function reachJobStatus(channelId: string) {
  return cached(`reachjob.${channelId}`, 30 * MIN, async () => (await findReachJob(channelId)) != null);
}
