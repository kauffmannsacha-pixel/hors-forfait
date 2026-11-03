// Normalisation des valeurs écrites par d'autres modules / par Claude (noms d'options, dates, personnes…).
import type { Page, SelectOption } from '../db/types';
import { parseDateInput, readDate, writeDate } from './dates';
import { asBool, asFiles, asList, asNumber, asText } from './engine';
import { COLORS, newId, nextColor, type FileRef, type Person, type PropDef } from './model';

export interface CoerceEnv {
  people: Person[];
  /** Lignes vivantes d'une base (pour résoudre une relation par titre). */
  rowsOf: (dbId: string) => Page[];
}
export interface CoerceResult { value: unknown; options?: SelectOption[]; newPeople?: Person[]; skip?: boolean }

function resolveOption(opts: SelectOption[], raw: unknown): string | null {
  const s = asText(raw).trim(); if (!s) return null;
  const hit = opts.find(o => o.name === s) ?? opts.find(o => o.name.toLowerCase() === s.toLowerCase()) ?? opts.find(o => o.id === s);
  if (hit) return hit.name;
  opts.push({ id: newId(), name: s, color: nextColor(opts.map(o => o.color)) });
  return s;
}

/** Convertit une valeur « libre » en valeur stockable pour la propriété. */
export function coerceInput(def: PropDef, v: unknown, env: CoerceEnv): CoerceResult {
  switch (def.type) {
    case 'title': case 'text': case 'url': case 'email': case 'phone':
      return { value: v instanceof Date ? v.toISOString() : asText(v) };
    case 'number': return { value: asNumber(v) };
    case 'checkbox': return { value: asBool(v) };
    case 'select': case 'status': {
      const opts = (def.options ?? []).map(o => ({ ...o }));
      const before = opts.length;
      const value = resolveOption(opts, Array.isArray(v) ? v[0] : v);
      return { value, ...(opts.length !== before ? { options: opts } : {}) };
    }
    case 'multi_select': {
      const opts = (def.options ?? []).map(o => ({ ...o }));
      const before = opts.length;
      const items = Array.isArray(v) ? v : asText(v).split(',');
      const value = [...new Set(items.map(x => resolveOption(opts, x)).filter((x): x is string => !!x))];
      return { value, ...(opts.length !== before ? { options: opts } : {}) };
    }
    case 'date': {
      if (v === null || v === undefined || v === '') return { value: null };
      if (v instanceof Date || typeof v === 'number') {
        const d = parseDateInput(v);
        return { value: d ? writeDate(d, null, d.getHours() !== 0 || d.getMinutes() !== 0) : null };
      }
      const r = readDate(v);
      return { value: r ? writeDate(r.start, r.end, r.hasTime) : null };
    }
    case 'person': {
      const people = [...env.people]; const created: Person[] = [];
      const ids = asList(v).flatMap(x => x.split(',')).map(x => x.trim()).filter(Boolean).map(x => {
        const p = people.find(q => q.id === x) ?? people.find(q => q.name.toLowerCase() === x.toLowerCase() || q.email?.toLowerCase() === x.toLowerCase());
        if (p) return p.id;
        const np: Person = { id: newId(), name: x, color: COLORS[1 + (people.length % (COLORS.length - 1))], ...(x.includes('@') ? { email: x } : {}) };
        people.push(np); created.push(np); return np.id;
      });
      return { value: [...new Set(ids)], ...(created.length ? { newPeople: created } : {}) };
    }
    case 'file': {
      const list = Array.isArray(v) ? v : v ? [v] : [];
      const value: FileRef[] = asFiles(list.map(x => (x && typeof x === 'object' && 'hash' in (x as object) ? { hash: (x as FileRef).hash, name: (x as FileRef).name, mime: (x as FileRef).mime } : x)));
      return { value };
    }
    case 'relation': {
      const target = def.relation?.databaseId;
      const rows = target ? env.rowsOf(target) : [];
      const ids = asList(v).map(x => {
        if (rows.some(r => r.id === x) || !target) return x;
        return rows.find(r => r.title.trim().toLowerCase() === x.trim().toLowerCase())?.id;
      }).filter((x): x is string => !!x);
      return { value: [...new Set(ids)] };
    }
    default: return { value: undefined, skip: true }; // propriétés calculées : non modifiables
  }
}
