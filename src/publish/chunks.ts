// Logique pure de l'envoi reprenable YouTube (protocole « resumable » de la Data API v3).
// Les morceaux font un multiple de 256 Kio (sauf le dernier) ; Content-Range : « bytes DEBUT-FIN/TOTAL ».

export const QUANTUM = 256 * 1024;              // 256 Kio — granularité imposée par YouTube
export const CHUNK_SIZE = 8 * 1024 * 1024;      // 8 Mio = 32 × 256 Kio
export const MAX_FILE_SIZE = 256 * 1024 ** 3;   // 256 Go (limite de videos.insert)

export interface ChunkPlan { offset: number; len: number; last: number; contentRange: string; final: boolean }

/** Arrondit une taille de morceau au multiple de 256 Kio inférieur (minimum 256 Kio). */
export function normalizeChunkSize(size: number): number {
  if (!Number.isFinite(size) || size <= QUANTUM) return QUANTUM;
  return Math.floor(size / QUANTUM) * QUANTUM;
}

/** En-tête Content-Range d'un morceau. */
export function contentRange(offset: number, len: number, total: number): string {
  return `bytes ${offset}-${offset + len - 1}/${total}`;
}
/** En-tête Content-Range d'une demande d'état (reprise après coupure). */
export const statusContentRange = (total: number) => `bytes */${total}`;

/** Plan du prochain morceau à envoyer à partir de `offset`. */
export function planChunk(offset: number, total: number, chunkSize = CHUNK_SIZE): ChunkPlan {
  if (!Number.isInteger(total) || total <= 0) throw new Error('Taille de fichier invalide.');
  if (!Number.isInteger(offset) || offset < 0 || offset >= total) throw new RangeError(`Position ${offset} hors du fichier (${total} octets).`);
  const size = normalizeChunkSize(chunkSize);
  const len = Math.min(size, total - offset);
  return { offset, len, last: offset + len - 1, contentRange: contentRange(offset, len, total), final: offset + len === total };
}

/** Tous les morceaux d'un fichier à partir d'une position (utile pour l'affichage et les tests). */
export function planChunks(total: number, chunkSize = CHUNK_SIZE, from = 0): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  for (let o = from; o < total; ) { const p = planChunk(o, total, chunkSize); out.push(p); o += p.len; }
  return out;
}

/** Vérifie la règle YouTube : multiple de 256 Kio, sauf pour le dernier morceau. */
export function isValidChunk(offset: number, len: number, total: number): boolean {
  return len > 0 && offset >= 0 && offset + len <= total && (len % QUANTUM === 0 || offset + len === total);
}

/** En-tête Range d'une réponse 308 (« bytes=0-999999 ») → prochaine position à envoyer (1 000 000). Absent → 0. */
export function nextOffsetFromRange(range?: string | null): number {
  if (!range) return 0;
  const m = /(\d+)\s*-\s*(\d+)/.exec(range);
  return m ? Number(m[2]) + 1 : 0;
}

/** Attente exponentielle avec gigue (1 s, 2 s, 4 s… plafonnée à 64 s), ou Retry-After si fourni. */
export function backoffDelay(attempt: number, random: () => number = Math.random, retryAfterSec?: number | null, baseMs = 1000, maxMs = 64_000): number {
  if (retryAfterSec != null && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 10 * 60_000);
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Mesure de débit sur une fenêtre glissante + estimation du temps restant. */
export class SpeedMeter {
  private pts: { t: number; bytes: number }[] = [];
  constructor(private windowMs = 20_000) {}
  /** `bytes` = total cumulé envoyé (pas un incrément). */
  add(bytes: number, t = Date.now()) {
    const last = this.pts[this.pts.length - 1];
    if (last && bytes < last.bytes) this.pts = []; // reprise plus bas (le serveur a moins reçu) → on repart
    this.pts.push({ t, bytes });
    while (this.pts.length > 2 && t - this.pts[0].t > this.windowMs) this.pts.shift();
  }
  reset() { this.pts = []; }
  bytesPerSec(): number {
    if (this.pts.length < 2) return 0;
    const a = this.pts[0], b = this.pts[this.pts.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0.2 ? Math.max(0, (b.bytes - a.bytes) / dt) : 0;
  }
  eta(remainingBytes: number): number | null {
    const s = this.bytesPerSec();
    return s > 0 ? Math.max(0, Math.round(remainingBytes / s)) : null;
  }
}

const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : nf1.format(v)} ${u[i]}`;
}
export const formatSpeed = (bps: number) => bps > 0 ? `${formatBytes(bps)}/s` : '—';
export function formatEta(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return 'calcul…';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}
