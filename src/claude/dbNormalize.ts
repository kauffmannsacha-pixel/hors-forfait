// Normalisation des bases générées par Claude (pur, testable) : propriétés autorisées,
// options de sélection, valeurs de lignes (dates ISO, nombres, cases à cocher…).
import type { PropertyDef, PropertyType, SelectOption } from '../db/types';

export const CREATABLE_TYPES: PropertyType[] = ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'person'];
const COLOR_CYCLE = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray'];

const TYPE_ALIASES: Record<string, PropertyType> = {
  texte: 'text', string: 'text', rich_text: 'text', nombre: 'number', int: 'number', integer: 'number', float: 'number',
  choix: 'select', selection: 'select', 'sélection': 'select', tags: 'multi_select', multiselect: 'multi_select', 'multi-select': 'multi_select',
  statut: 'status', bool: 'checkbox', boolean: 'checkbox', case: 'checkbox', lien: 'url', link: 'url', mail: 'email', 'e-mail': 'email',
  telephone: 'phone', 'téléphone': 'phone', personne: 'person', people: 'person', datetime: 'date',
};

export interface GeneratedProperty { name: string; type: string; options?: unknown }
export type PropInit = Omit<PropertyDef, 'id'>;

const optionNames = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.map(o => (typeof o === 'string' ? o : o && typeof o === 'object' && 'name' in o ? String((o as { name: unknown }).name) : String(o)))
    .map(s => s.trim()).filter(Boolean);
};

/** Propriétés générées → définitions valides (la colonne titre est gérée à part). */
export function normalizeProperties(input: unknown, titleName?: string): PropInit[] {
  const out: PropInit[] = []; const seen = new Set<string>();
  if (titleName) seen.add(titleName.toLowerCase());
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as GeneratedProperty;
    const name = String(p.name ?? '').trim().slice(0, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    const t = String(p.type ?? 'text').trim().toLowerCase();
    if (t === 'title') continue;
    const type = (CREATABLE_TYPES as string[]).includes(t) ? (t as PropertyType) : (TYPE_ALIASES[t] ?? 'text');
    const def: PropInit = { name, type };
    if (type === 'select' || type === 'multi_select' || type === 'status') {
      const names = [...new Set(optionNames(p.options))].slice(0, 50);
      const base = names.length ? names : type === 'status' ? ['À faire', 'En cours', 'Terminé'] : [];
      def.options = base.map((n, i) => ({ id: '', name: n, color: COLOR_CYCLE[i % COLOR_CYCLE.length] }));
    }
    if (type === 'number') def.numberFormat = 'number';
    seen.add(name.toLowerCase());
    out.push(def);
  }
  return out;
}

/** Date libre → « yyyy-MM-dd » (ou « yyyy-MM-ddTHH:mm »), sinon null. */
export function normalizeDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (m) return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export function normalizeNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[\s  €$%]/g, '').replace(/,(\d+)$/, '.$1').replace(/,/g, '');
  const n = Number(cleaned);
  return cleaned && Number.isFinite(n) ? n : null;
}

export function normalizeBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return /^(true|oui|yes|vrai|x|✓|✔|1|coché)$/i.test(String(v ?? '').trim());
}

/**
 * Valeurs d'une ligne indexées par NOM de propriété (comme attendu par addRow).
 * Les options de sélection manquantes sont ajoutées au schéma (mutation de `props`).
 */
export function normalizeRow(values: Record<string, unknown>, props: (PropertyDef | PropInit)[], titleName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lower = new Map(Object.entries(values ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const titleVal = lower.get(titleName.toLowerCase()) ?? lower.get('title') ?? lower.get('titre') ?? lower.get('nom') ?? lower.get('name');
  out.title = String(titleVal ?? '').trim();
  for (const p of props) {
    if (p.type === 'title') continue;
    const v = lower.get(p.name.toLowerCase());
    if (v === undefined || v === null || v === '') continue;
    switch (p.type) {
      case 'number': { const n = normalizeNumber(v); if (n !== null) out[p.name] = n; break; }
      case 'checkbox': out[p.name] = normalizeBool(v); break;
      case 'date': {
        if (v && typeof v === 'object' && 'start' in (v as Record<string, unknown>)) {
          const o = v as { start?: unknown; end?: unknown };
          const start = normalizeDate(o.start); if (start) out[p.name] = { start, end: normalizeDate(o.end) };
        } else { const d = normalizeDate(v); if (d) out[p.name] = d; }
        break;
      }
      case 'select': case 'status': {
        const name = String(Array.isArray(v) ? v[0] ?? '' : v).trim();
        if (name) { ensureOption(p, name); out[p.name] = name; }
        break;
      }
      case 'multi_select': {
        const list = (Array.isArray(v) ? v.map(String) : String(v).split(',')).map(s => s.trim()).filter(Boolean);
        list.forEach(n => ensureOption(p, n));
        if (list.length) out[p.name] = list;
        break;
      }
      default: out[p.name] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return out;
}

function ensureOption(p: { options?: SelectOption[] }, name: string) {
  const opts = p.options ?? (p.options = []);
  if (!opts.some(o => o.name.toLowerCase() === name.toLowerCase())) opts.push({ id: '', name, color: COLOR_CYCLE[opts.length % COLOR_CYCLE.length] });
}
