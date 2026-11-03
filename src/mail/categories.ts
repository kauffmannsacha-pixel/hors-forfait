// Tri automatique des mails par Claude : catégories, urgence, analyse des réponses (pur, testé).
import type { MailCategory, MailHeader, TriageResult } from './types';
import { clip, fold } from './util';

export const DEFAULT_CATEGORIES: MailCategory[] = [
  { id: 'sponsors', name: 'Sponsors', color: '#ff9f0a', description: 'Propositions de partenariat rémunéré, placement de produit, agences et marques, négociations de tarifs.' },
  { id: 'collabs', name: 'Collabs', color: '#bf5af2', description: "Propositions de collaboration avec d'autres créateurs, invitations à des vidéos, événements, podcasts." },
  { id: 'fans', name: 'Fans', color: '#30d158', description: 'Messages de spectateurs ou abonnés : remerciements, questions, idées de vidéos, demandes personnelles.' },
  { id: 'factures', name: 'Factures', color: '#64d2ff', description: 'Factures, reçus, paiements, relevés, devis, comptabilité, impôts, URSSAF.' },
  { id: 'autre', name: 'Autre', color: '#8e8e93', description: 'Tout le reste : newsletters, notifications, administratif, publicité.' },
];
export const FALLBACK_CATEGORY = 'autre';

/** Synonymes reconnus dans les réponses de Claude (ou saisis à la main). */
const ALIASES: Record<string, string[]> = {
  sponsors: ['sponsor', 'sponsors', 'sponsoring', 'partenariat', 'partenariats', 'partnership', 'brand deal', 'placement de produit', 'marque', 'marques', 'pub', 'publicite'],
  collabs: ['collab', 'collabs', 'collaboration', 'collaborations', 'createur', 'createurs', 'featuring', 'feat'],
  fans: ['fan', 'fans', 'abonne', 'abonnes', 'spectateur', 'spectateurs', 'communaute', 'viewer', 'viewers'],
  factures: ['facture', 'factures', 'invoice', 'invoices', 'recu', 'recus', 'paiement', 'paiements', 'payment', 'compta', 'comptabilite', 'devis', 'billing'],
  autre: ['autre', 'autres', 'other', 'others', 'divers', 'newsletter', 'notification', 'notifications', 'spam'],
};

/** Ramène un nom de catégorie libre à l'id d'une catégorie connue (sinon « autre » ou la 1re). */
export function normalizeCategory(name: unknown, cats: MailCategory[] = DEFAULT_CATEGORIES): string {
  const fallback = cats.find(c => c.id === FALLBACK_CATEGORY)?.id ?? cats[cats.length - 1]?.id ?? FALLBACK_CATEGORY;
  if (typeof name !== 'string' || !name.trim()) return fallback;
  const n = fold(name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const direct = cats.find(c => fold(c.id) === n || fold(c.name) === n);
  if (direct) return direct.id;
  for (const c of cats) {
    const al = ALIASES[c.id] ?? [];
    if (al.includes(n) || (n.endsWith('s') && al.includes(n.slice(0, -1)))) return c.id;
  }
  // correspondance partielle (« Sponsor / marque » → sponsors)
  for (const c of cats) {
    const words = [fold(c.name), ...(ALIASES[c.id] ?? [])];
    if (words.some(w => w.length > 3 && (n.includes(w) || w.includes(n)))) return c.id;
  }
  return fallback;
}

export function normalizeUrgent(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') return ['true', 'oui', 'yes', '1', 'urgent', 'vrai', 'haute', 'high'].includes(fold(v));
  return false;
}

export interface TriageItem { id: string; from: string; subject: string; snippet: string; date: string }

export const triageItem = (h: MailHeader, id = h.key): TriageItem => ({
  id,
  from: h.from.name ? `${h.from.name} <${h.from.email}>` : h.from.email,
  subject: clip(h.subject || '(sans objet)', 160),
  snippet: clip(h.snippet || '', 280),
  date: new Date(h.date || Date.now()).toISOString().slice(0, 16).replace('T', ' '),
});

export const TRIAGE_SYSTEM = `Tu tries la boîte mail d'un créateur YouTube francophone. Pour CHAQUE mail, choisis UNE catégorie et indique s'il est urgent.
Un mail est urgent s'il exige une action ou une réponse sous 48 h : échéance proche, paiement en retard ou imminent, contrat à signer, tournage/événement imminent, problème légal ou de compte (droits d'auteur, sécurité), proposition commerciale avec date limite courte. Les newsletters, promotions et notifications automatiques ne sont jamais urgentes.`;

export function buildTriagePrompt(items: TriageItem[], cats: MailCategory[]): string {
  const catLines = cats.map(c => `- "${c.id}" (${c.name}) : ${c.description}`).join('\n');
  return `Catégories possibles :\n${catLines}\n\nMails à trier (JSON) :\n${JSON.stringify(items)}\n\nRéponds avec un tableau JSON, un objet par mail, dans le même ordre :\n[{"id":"…","category":"<id de catégorie>","urgent":true|false,"reason":"raison courte (8 mots max)"}]`;
}

/**
 * Analyse la réponse de Claude (texte brut ou objet déjà parsé). Tolérant : bloc ```json, objet
 * { results: [...] }, map { id: {...} }, noms de catégories approximatifs, urgent en texte.
 * Ne garde que les ids attendus.
 */
export function parseTriageResponse(raw: unknown, cats: MailCategory[], expectedIds: string[], now = Date.now()): Record<string, TriageResult> {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    const txt = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { data = JSON.parse(txt); } catch {
      const s = txt.search(/[[{]/); const e = Math.max(txt.lastIndexOf(']'), txt.lastIndexOf('}'));
      try { data = s >= 0 && e > s ? JSON.parse(txt.slice(s, e + 1)) : null; } catch { data = null; }
    }
  }
  let rows: unknown[] = [];
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const arr = o.results ?? o.mails ?? o.items ?? o.emails ?? o.classification;
    if (Array.isArray(arr)) rows = arr;
    else rows = Object.entries(o).filter(([, v]) => v && typeof v === 'object').map(([id, v]) => ({ id, ...(v as object) }));
  }
  const allowed = new Set(expectedIds);
  const out: Record<string, TriageResult> = {};
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const o = r as Record<string, unknown>;
    let id = o.id !== undefined && o.id !== null ? String(o.id).trim() : '';
    // id absent ou inconnu : correspondance par position si Claude a répondu pour chaque mail
    if (!allowed.has(id) && rows.length === expectedIds.length) id = expectedIds[i];
    if (!allowed.has(id) || out[id]) return;
    const reason = typeof o.reason === 'string' ? o.reason : typeof o.raison === 'string' ? o.raison : undefined;
    out[id] = {
      category: normalizeCategory(o.category ?? o.categorie ?? o['catégorie'], cats),
      urgent: normalizeUrgent(o.urgent ?? o.urgence ?? o.priority),
      ...(reason ? { reason: clip(reason.trim(), 120) } : {}),
      at: now,
    };
  });
  return out;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Clé de cache du tri : Message-ID RFC si connu (stable entre dossiers), sinon clé interne. */
export const triageKey = (h: Pick<MailHeader, 'messageId' | 'key'>) => (h.messageId ? `mid:${h.messageId.toLowerCase()}` : h.key);
