// Changement de type d'une propriété : calcule la nouvelle définition + les valeurs converties. Pur.
import type { Page, PropertyType, SelectOption } from '../db/types';
import { isoDateTime, isoDay, parseDateInput, readDate } from './dates';
import {
  asBool, asFiles, asList, asNumber, asText, displayValue, optionFor, optionsFor, personFor, rawValue, relationIds, type EngineCtx,
} from './engine';
import { COLORS, DEFAULT_STATUS, isComputed, isSelectLike, newId, nextColor, type FileRef, type Person, type PropDef } from './model';

export interface ConversionPlan {
  prop: PropDef;
  /** Nouvelles valeurs par ligne (undefined = supprimer la valeur). */
  values: { rowId: string; value: unknown }[];
  /** Personnes à créer (conversion texte → personne). */
  newPeople: Person[];
  /** true si des données existantes seront perdues. */
  lossy: boolean;
}

const SPLIT = /\s*[,;\n]\s*/;

/** Éléments « liste » d'une cellule (pour multi-sélection, personnes…). */
function itemsOf(row: Page, prop: PropDef, ctx: EngineCtx): string[] {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'multi_select': return optionsFor(prop, raw).map(o => o.name);
    case 'select': case 'status': { const o = optionFor(prop, raw); return o ? [o.name] : []; }
    case 'person': return asList(raw).map(id => personFor(ctx, id).name);
    case 'relation': return relationIds(row, prop, ctx).map(id => ctx.getPage(id)?.title || '').filter(Boolean);
    case 'file': return asFiles(raw).map(f => f.name);
    case 'checkbox': return asBool(raw) ? ['Oui'] : [];
    default: return displayValue(row, prop, ctx).split(SPLIT).map(s => s.trim()).filter(Boolean);
  }
}

export function planConversion(from: PropDef, to: PropertyType, rows: Page[], ctx: EngineCtx): ConversionPlan {
  const prop: PropDef = { ...from, type: to };
  const values: { rowId: string; value: unknown }[] = [];
  const newPeople: Person[] = [];
  let lossy = false;
  const hasData = rows.some(r => {
    const v = rawValue(r, from);
    return !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
  });

  // Nettoyage de la configuration propre à l'ancien type.
  if (to !== 'number') { delete prop.numberFormat; delete prop.decimals; delete prop.showAs; delete prop.divideBy; }
  if (to !== 'relation') delete prop.relation;
  if (to !== 'rollup') delete prop.rollup;
  if (to !== 'formula') delete prop.formula;
  if (to === 'rollup') prop.rollup = { relationPropId: '', targetPropId: '', fn: 'count' };
  if (to === 'formula') prop.formula = '';

  // Types calculés : plus de valeurs stockées.
  if (isComputed(to)) {
    for (const r of rows) if (r.props && from.id in r.props) values.push({ rowId: r.id, value: undefined });
    return { prop, values, newPeople, lossy: hasData && !isComputed(from.type) };
  }
  if (to === 'relation') {
    for (const r of rows) {
      if (from.type === 'relation') continue;
      if (r.props && from.id in r.props) values.push({ rowId: r.id, value: undefined });
    }
    return { prop, values, newPeople, lossy: hasData && from.type !== 'relation' };
  }

  // Options des sélections : on garde celles de la source si elle en a.
  const opts: SelectOption[] = isSelectLike(from.type) ? (from.options ?? []).map(o => ({ ...o })) : [];
  const optionNamed = (name: string): string => {
    const found = opts.find(o => o.name.toLowerCase() === name.toLowerCase());
    if (found) return found.name;
    opts.push({ id: newId(), name, color: nextColor(opts.map(o => o.color)) });
    return name;
  };
  const people = [...ctx.people];
  const personNamed = (name: string): string => {
    const p = people.find(x => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
    if (p) return p.id;
    const np: Person = { id: newId(), name, color: COLORS[1 + (people.length % (COLORS.length - 1))] };
    people.push(np); newPeople.push(np); return np.id;
  };

  for (const r of rows) {
    const raw = rawValue(r, from);
    let value: unknown;
    switch (to) {
      case 'title': case 'text': case 'url': case 'email': case 'phone':
        value = from.type === 'checkbox' ? (asBool(raw) ? 'Oui' : 'Non') : displayValue(r, from, ctx) || undefined;
        if (to === 'title') value = value ?? '';
        break;
      case 'number':
        if (from.type === 'number') value = asNumber(raw);
        else if (from.type === 'checkbox') value = asBool(raw) ? 1 : 0;
        else if (from.type === 'date' || from.type === 'created_time' || from.type === 'updated_time') { const d = readDate(raw); value = d ? d.start.getTime() : null; if (d) lossy = true; }
        else { const t = displayValue(r, from, ctx); value = asNumber(t); if (t && value === null) lossy = true; }
        break;
      case 'select': case 'status': {
        const items = itemsOf(r, from, ctx);
        if (items.length > 1) lossy = true;
        value = items.length ? optionNamed(items[0]) : undefined;
        break;
      }
      case 'multi_select': value = itemsOf(r, from, ctx).map(optionNamed); if (!(value as string[]).length) value = undefined; break;
      case 'date': {
        if (from.type === 'date') value = raw;
        else if (from.type === 'created_time' || from.type === 'updated_time') value = isoDateTime(new Date(Number(raw)));
        else {
          const t = displayValue(r, from, ctx);
          const d = from.type === 'number' ? (asNumber(raw) !== null && Math.abs(asNumber(raw)!) > 1e9 ? parseDateInput(asNumber(raw)) : null) : parseDateInput(t);
          value = d ? (d.getHours() || d.getMinutes() ? isoDateTime(d) : isoDay(d)) : undefined;
          if (t && !d) lossy = true;
        }
        break;
      }
      case 'person': value = from.type === 'person' ? asList(raw) : itemsOf(r, from, ctx).map(personNamed); if (!(value as string[]).length) value = undefined; break;
      case 'checkbox':
        if (from.type === 'checkbox') value = asBool(raw);
        else if (from.type === 'number') value = (asNumber(raw) ?? 0) !== 0;
        else if (from.type === 'multi_select' || from.type === 'person' || from.type === 'relation' || from.type === 'file') value = itemsOf(r, from, ctx).length > 0;
        else value = asBool(displayValue(r, from, ctx));
        break;
      case 'file': {
        if (from.type === 'file') { value = raw; break; }
        const urls = itemsOf(r, from, ctx).filter(s => /^(https?:|data:|asset:)/i.test(s));
        value = urls.length ? urls.map<FileRef>(u => ({ url: u, name: u.split(/[/?#]/).filter(Boolean).pop() ?? u })) : undefined;
        if (!urls.length && displayValue(r, from, ctx)) lossy = true;
        break;
      }
    }
    if (to === 'title') { values.push({ rowId: r.id, value: asText(value) }); continue; }
    const before = r.props?.[from.id];
    if (JSON.stringify(before) !== JSON.stringify(value)) values.push({ rowId: r.id, value });
  }

  if (isSelectLike(to)) prop.options = opts.length ? opts : to === 'status' ? DEFAULT_STATUS.map(o => ({ ...o, id: newId() })) : [];
  else delete prop.options;
  return { prop, values, newPeople, lossy };
}
