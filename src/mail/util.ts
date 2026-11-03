// Utilitaires purs du module Mail (adresses, base64, dates, sujets…).
import type { MailAddress } from './types';

// ── Texte / HTML ──────────────────────────────────────────────
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Normalise pour comparaison (minuscules, sans accents). */
export const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// ── Adresses ──────────────────────────────────────────────────
export const normEmail = (e: string) => e.trim().toLowerCase();
export const isValidEmail = (e: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(e.trim());

/** « Nom <adresse> » (nom entre guillemets s'il contient des caractères spéciaux). */
export function formatAddress(a: MailAddress): string {
  if (!a.name || a.name.trim() === '' || normEmail(a.name) === normEmail(a.email)) return a.email;
  const n = a.name.trim();
  return /[(),.:;<>@[\]\\"]/.test(n) ? `"${n.replace(/(["\\])/g, '\\$1')}" <${a.email}>` : `${n} <${a.email}>`;
}
export const displayName = (a?: MailAddress) => (a ? (a.name?.trim() || a.email.split('@')[0]) : '');

/** Découpe une liste d'adresses RFC 5322 (virgules dans les guillemets / commentaires gérées). */
export function parseAddressList(input: string): MailAddress[] {
  const parts: string[] = [];
  let cur = ''; let quoted = false; let angle = 0; let paren = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && quoted) { cur += c + (input[i + 1] ?? ''); i++; continue; }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle++;
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && c === '(') paren++;
    else if (!quoted && c === ')') paren = Math.max(0, paren - 1);
    if ((c === ',' || c === ';') && !quoted && angle === 0 && paren === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const out: MailAddress[] = [];
  for (const raw of parts) {
    const p = raw.trim(); if (!p) continue;
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(p);
    if (m) {
      const email = m[2].trim();
      let name = m[1].trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();
      if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1);
      if (email) out.push(name ? { name, email } : { email });
    } else {
      const email = p.replace(/\(.*?\)/g, '').replace(/^"|"$/g, '').trim();
      const comment = /\((.*?)\)/.exec(p)?.[1]?.trim();
      if (email.includes('@')) out.push(comment ? { name: comment, email } : { email });
    }
  }
  return out;
}

/** Dédoublonne (par adresse) en conservant le premier nom connu. */
export function uniqAddresses(list: MailAddress[], exclude: string[] = []): MailAddress[] {
  const seen = new Set(exclude.map(normEmail)); const out: MailAddress[] = [];
  for (const a of list) {
    const k = normEmail(a.email); if (!k || seen.has(k)) continue;
    seen.add(k); out.push(a);
  }
  return out;
}

export function initials(a?: MailAddress): string {
  const n = displayName(a).replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
  if (!n) return '?';
  const w = n.split(/\s+/);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

const AVATAR_COLORS = ['#ff6b6b', '#f59f00', '#37b24d', '#1c7ed6', '#7048e8', '#e64980', '#0ca678', '#f76707', '#4263eb', '#ae3ec9'];
export function colorFor(seed: string): string {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Sujets ────────────────────────────────────────────────────
const PREFIX = /^\s*((re|r[ée]f|aw|antw|sv|vs|fw|fwd|tr|wg|rv|enc)\s*(\[\d+\])?\s*:\s*)+/i;
export const hasReplyPrefix = (s: string) => PREFIX.test(s);
export function normalizeSubject(s: string): string {
  let t = (s ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 5 && PREFIX.test(t); i++) t = t.replace(PREFIX, '').trim();
  return t.replace(/^\[[^\]]{1,40}\]\s*/, (m) => (/^\[(ext|externe|external)\]/i.test(m) ? '' : m)).trim();
}

// ── Base64 ────────────────────────────────────────────────────
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '==='.slice((clean.length + 3) % 4);
  const bin = atob(padded); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const utf8ToBase64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
export const base64ToUtf8 = (b64: string) => new TextDecoder().decode(base64ToBytes(b64));
export const toBase64Url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const base64UrlToBase64 = (s: string) => { const c = s.replace(/-/g, '+').replace(/_/g, '/'); return c + '==='.slice((c.length + 3) % 4); };

/** Décode des octets selon un charset (repli UTF-8, puis windows-1252). */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const cs = (charset ?? 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs, { fatal: false }).decode(bytes); }
  catch { /* charset inconnu */ }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 o';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} Go`;
}

// ── Dates (FR) ────────────────────────────────────────────────
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Date compacte pour la liste : « 14:05 », « Hier », « lun. », « 12/10/2026 ». */
export function listDate(ms: number, now = new Date()): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (sameDay(d, now)) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Hier';
  const diff = (now.getTime() - d.getTime()) / 86400000;
  if (diff > 0 && diff < 6) return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
/** « lun. 3 nov. 2026 à 14:05 » */
export function longDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Exécute des tâches avec une concurrence limitée. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Vrai si l'erreur ressemble à une coupure réseau (→ mode hors-ligne). */
export function isNetworkError(e: unknown): boolean {
  const m = errorText(e).toLowerCase();
  return /failed to fetch|network|networkerror|load failed|hors ligne|offline|timed out|délai dépassé|impossible de joindre|dns|error sending request|connection (refused|reset)|introuvable \(vérifie le nom d'hôte et ta connexion/.test(m);
}
