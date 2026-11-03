// Instantanés de statistiques (kv 'stats:snapshots') : vues relevées périodiquement après une publication.
// Lecture tolérante (le module Stats peut écrire dans un autre format) ; écriture dans le format déjà présent.
// Format par défaut : { [videoId]: { t: ms, views, likes?, comments? }[] }.
import { youtube } from '../connectors/api';
import { repo } from '../db/store';
import type { PublishedVideo } from './types';

export const SNAP_KEY = 'stats:snapshots';
export interface SnapPoint { t: number; views: number; likes?: number; comments?: number }

const H = 3_600_000;
const toMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : /^\d+$/.test(v) ? toMs(Number(v)) : null; }
  return null;
};
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
function point(o: unknown): (SnapPoint & { videoId?: string }) | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const t = toMs(r.t ?? r.at ?? r.ts ?? r.time ?? r.timestamp ?? r.date);
  const views = num(r.views ?? r.viewCount ?? r.v);
  if (t == null || !Number.isFinite(views)) return null;
  const likes = num(r.likes ?? r.likeCount), comments = num(r.comments ?? r.commentCount);
  return { t, views, ...(Number.isFinite(likes) ? { likes } : {}), ...(Number.isFinite(comments) ? { comments } : {}), ...(typeof (r.videoId ?? r.id) === 'string' ? { videoId: String(r.videoId ?? r.id) } : {}) };
}

/** Normalise n'importe quelle forme raisonnable en Map videoId → points triés. */
export function normalizeSnapshots(raw: unknown): Map<string, SnapPoint[]> {
  const out = new Map<string, SnapPoint[]>();
  const add = (id: string, p: SnapPoint | null) => { if (!p) return; const a = out.get(id) ?? []; a.push({ t: p.t, views: p.views, ...(p.likes != null ? { likes: p.likes } : {}), ...(p.comments != null ? { comments: p.comments } : {}) }); out.set(id, a); };
  if (Array.isArray(raw)) { for (const x of raw) { const p = point(x); if (p?.videoId) add(p.videoId, p); } }
  else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const inner = (obj.videos ?? obj.byVideo ?? obj.data) as unknown;
    const src = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : obj;
    for (const [id, v] of Object.entries(src)) {
      const list = Array.isArray(v) ? v : v && typeof v === 'object' ? ((v as Record<string, unknown>).points ?? (v as Record<string, unknown>).snapshots ?? (v as Record<string, unknown>).history) : null;
      if (Array.isArray(list)) for (const x of list) add(id, point(x));
    }
  }
  for (const a of out.values()) a.sort((x, y) => x.t - y.t);
  return out;
}

export async function readSnapshots(): Promise<Map<string, SnapPoint[]>> {
  try { return normalizeSnapshots(await repo.kvGet<unknown>(SNAP_KEY)); } catch { return new Map(); }
}

/** Ajoute des points en respectant la forme existante de la clé. */
export async function appendSnapshots(points: (SnapPoint & { videoId: string })[]): Promise<void> {
  if (!points.length) return;
  const raw = await repo.kvGet<unknown>(SNAP_KEY);
  if (Array.isArray(raw)) { await repo.kvSet(SNAP_KEY, [...raw, ...points]); return; }
  const obj: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  const nested = ['videos', 'byVideo'].find(k => obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]));
  const target: Record<string, unknown> = nested ? { ...(obj[nested] as Record<string, unknown>) } : obj;
  for (const p of points) {
    const { videoId, ...pt } = p;
    const cur = target[videoId];
    if (Array.isArray(cur)) target[videoId] = [...cur, pt].slice(-600);
    else if (cur && typeof cur === 'object' && Array.isArray((cur as Record<string, unknown>).points)) target[videoId] = { ...(cur as Record<string, unknown>), points: [...((cur as { points: unknown[] }).points), pt].slice(-600) };
    else target[videoId] = [pt];
  }
  if (nested) obj[nested] = target;
  await repo.kvSet(SNAP_KEY, nested ? obj : target);
}

/** Intervalle voulu entre deux relevés selon l'âge de la vidéo (horaire les 48 premières heures). */
export function snapshotInterval(ageMs: number): number | null {
  if (ageMs < 0) return null;
  if (ageMs < 48 * H) return 55 * 60_000;
  if (ageMs < 7 * 24 * H) return 6 * H;
  if (ageMs < 30 * 24 * H) return 23 * H;
  return null;
}

/** Relève les vues des vidéos publiées via Prisme quand c'est l'heure (appelé périodiquement). */
export async function snapshotDue(history: PublishedVideo[], now = Date.now()): Promise<number> {
  const snaps = await readSnapshots();
  const due = history.filter(h => {
    const iv = snapshotInterval(now - h.publishedAt);
    if (iv == null) return false;
    const pts = snaps.get(h.videoId);
    const last = pts?.length ? pts[pts.length - 1].t : 0;
    return now - last >= iv;
  }).map(h => h.videoId);
  if (!due.length) return 0;
  const points: (SnapPoint & { videoId: string })[] = [];
  for (let i = 0; i < due.length; i += 50) {
    const vids = await youtube.videos(due.slice(i, i + 50));
    for (const v of vids) points.push({ videoId: v.id, t: now, views: v.views, likes: v.likes, comments: v.comments });
  }
  await appendSnapshots(points);
  return points.length;
}
