// Filtres (par type, mode ET/OU), tris multiples, recherche, groupement et calculs de pied de tableau. Pur.
import {
  addDays, addMonths, addWeeks, differenceInCalendarDays, endOfMonth, endOfWeek, isValid, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import type { FilterRule, Page, SortRule } from '../db/types';
import { parseDateInput, readDate } from './dates';
import {
  asBool, asFiles, asList, asNumber, asText, computed, displayValue, formatFValue, formatNumber, formulaValue, isEmptyValue,
  kindOf, optionFor, optionsFor, personFor, rawValue, relationIds, rollupNumberProp, type EngineCtx, type ValueKind,
} from './engine';
import type { FValue } from './formula';
import { norm, type CalcFn, type PropDef, type ViewX } from './model';

// ── Opérateurs de filtre ─────────────────────────────────────
export interface FilterOp { id: string; label: string; needsValue: boolean; input?: 'text' | 'number' | 'date' | 'option' | 'person' | 'relation' | 'days' }
const EMPTY_OPS: FilterOp[] = [
  { id: 'empty', label: 'est vide', needsValue: false },
  { id: 'not_empty', label: 'n’est pas vide', needsValue: false },
];
const TEXT_OPS: FilterOp[] = [
  { id: 'is', label: 'est', needsValue: true, input: 'text' },
  { id: 'is_not', label: 'n’est pas', needsValue: true, input: 'text' },
  { id: 'contains', label: 'contient', needsValue: true, input: 'text' },
  { id: 'not_contains', label: 'ne contient pas', needsValue: true, input: 'text' },
  { id: 'starts_with', label: 'commence par', needsValue: true, input: 'text' },
  { id: 'ends_with', label: 'se termine par', needsValue: true, input: 'text' },
  ...EMPTY_OPS,
];
const NUMBER_OPS: FilterOp[] = [
  { id: 'eq', label: '=', needsValue: true, input: 'number' },
  { id: 'neq', label: '≠', needsValue: true, input: 'number' },
  { id: 'gt', label: '>', needsValue: true, input: 'number' },
  { id: 'lt', label: '<', needsValue: true, input: 'number' },
  { id: 'gte', label: '≥', needsValue: true, input: 'number' },
  { id: 'lte', label: '≤', needsValue: true, input: 'number' },
  ...EMPTY_OPS,
];
const SELECT_OPS: FilterOp[] = [
  { id: 'is', label: 'est', needsValue: true, input: 'option' },
  { id: 'is_not', label: 'n’est pas', needsValue: true, input: 'option' },
  ...EMPTY_OPS,
];
const MULTI_OPS: FilterOp[] = [
  { id: 'contains', label: 'contient', needsValue: true, input: 'option' },
  { id: 'not_contains', label: 'ne contient pas', needsValue: true, input: 'option' },
  ...EMPTY_OPS,
];
const DATE_OPS: FilterOp[] = [
  { id: 'is', label: 'est le', needsValue: true, input: 'date' },
  { id: 'before', label: 'est avant', needsValue: true, input: 'date' },
  { id: 'after', label: 'est après', needsValue: true, input: 'date' },
  { id: 'on_or_before', label: 'est le ou avant', needsValue: true, input: 'date' },
  { id: 'on_or_after', label: 'est le ou après', needsValue: true, input: 'date' },
  { id: 'today', label: 'est aujourd’hui', needsValue: false },
  { id: 'this_week', label: 'cette semaine', needsValue: false },
  { id: 'last_week', label: 'la semaine dernière', needsValue: false },
  { id: 'next_week', label: 'la semaine prochaine', needsValue: false },
  { id: 'this_month', label: 'ce mois-ci', needsValue: false },
  { id: 'last_month', label: 'le mois dernier', needsValue: false },
  { id: 'next_month', label: 'le mois prochain', needsValue: false },
  { id: 'past_days', label: 'dans les N derniers jours', needsValue: true, input: 'days' },
  { id: 'next_days', label: 'dans les N prochains jours', needsValue: true, input: 'days' },
  { id: 'past', label: 'est passée', needsValue: false },
  { id: 'future', label: 'est à venir', needsValue: false },
  ...EMPTY_OPS,
];
const CHECKBOX_OPS: FilterOp[] = [
  { id: 'checked', label: 'est cochée', needsValue: false },
  { id: 'unchecked', label: 'n’est pas cochée', needsValue: false },
];
const PERSON_OPS: FilterOp[] = [
  { id: 'contains', label: 'contient', needsValue: true, input: 'person' },
  { id: 'not_contains', label: 'ne contient pas', needsValue: true, input: 'person' },
  ...EMPTY_OPS,
];
const RELATION_OPS: FilterOp[] = [
  { id: 'contains', label: 'contient', needsValue: true, input: 'relation' },
  { id: 'not_contains', label: 'ne contient pas', needsValue: true, input: 'relation' },
  ...EMPTY_OPS,
];

export const OPS_BY_KIND: Record<ValueKind, FilterOp[]> = {
  text: TEXT_OPS, number: NUMBER_OPS, date: DATE_OPS, checkbox: CHECKBOX_OPS, select: SELECT_OPS, multi: MULTI_OPS,
  person: PERSON_OPS, file: EMPTY_OPS, relation: RELATION_OPS,
};
export const opsFor = (prop: PropDef, ctx?: EngineCtx, rows?: Page[]) => OPS_BY_KIND[kindOf(prop, ctx, rows)];
export const defaultOp = (prop: PropDef, ctx?: EngineCtx, rows?: Page[]) => opsFor(prop, ctx, rows)[0].id;

// ── Évaluation d'une règle ───────────────────────────────────
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function dateOf(row: Page, prop: PropDef, ctx: EngineCtx): { start: Date; end: Date } | null {
  if (prop.type === 'formula' || prop.type === 'rollup') {
    const c = computed(row, prop, ctx);
    if ('error' in c) return null;
    const v = Array.isArray(c.value) ? c.value[0] : c.value;
    const d = v instanceof Date ? v : parseDateInput(v as string);
    return d ? { start: d, end: d } : null;
  }
  const r = readDate(rawValue(row, prop));
  return r ? { start: r.start, end: r.end ?? r.start } : null;
}
function inRange(d: { start: Date; end: Date }, from: Date, to: Date) {
  return startOfDay(d.end) >= startOfDay(from) && startOfDay(d.start) <= startOfDay(to);
}

/** Valeur comparable « texte » d'une cellule. */
function textOf(row: Page, prop: PropDef, ctx: EngineCtx): string {
  if (prop.type === 'formula' || prop.type === 'rollup') {
    const c = computed(row, prop, ctx); return 'error' in c ? '' : formatFValue(c.value);
  }
  return displayValue(row, prop, ctx);
}
function numberOf(row: Page, prop: PropDef, ctx: EngineCtx): number | null {
  if (prop.type === 'formula' || prop.type === 'rollup') {
    const c = computed(row, prop, ctx); if ('error' in c) return null;
    const v = Array.isArray(c.value) ? c.value[0] : c.value;
    return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : asNumber(v as unknown);
  }
  return asNumber(rawValue(row, prop));
}

/** true si la règle est complète (sinon elle est ignorée, comme dans Notion). */
export function ruleIsActive(rule: FilterRule, prop: PropDef | undefined, ctx?: EngineCtx, rows?: Page[]): boolean {
  if (!prop) return false;
  const op = opsFor(prop, ctx, rows).find(o => o.id === rule.op);
  if (!op) return false;
  return !op.needsValue || !isBlank(rule.value);
}

export function matchRule(row: Page, rule: FilterRule, prop: PropDef, ctx: EngineCtx, kind = kindOf(prop, ctx)): boolean {
  const v = rule.value;
  if (rule.op === 'empty') return isEmptyValue(row, prop, ctx);
  if (rule.op === 'not_empty') return !isEmptyValue(row, prop, ctx);
  switch (kind) {
    case 'text': {
      const a = norm(textOf(row, prop, ctx).trim()); const b = norm(asText(v).trim());
      switch (rule.op) {
        case 'is': return a === b;
        case 'is_not': return a !== b;
        case 'contains': return a.includes(b);
        case 'not_contains': return !a.includes(b);
        case 'starts_with': return a.startsWith(b);
        case 'ends_with': return a.endsWith(b);
      }
      return true;
    }
    case 'number': {
      const a = numberOf(row, prop, ctx); const b = asNumber(v);
      if (b === null) return true;
      if (a === null) return rule.op === 'neq';
      switch (rule.op) {
        case 'eq': return a === b; case 'neq': return a !== b; case 'gt': return a > b;
        case 'lt': return a < b; case 'gte': return a >= b; case 'lte': return a <= b;
      }
      return true;
    }
    case 'checkbox': {
      const a = prop.type === 'checkbox' ? asBool(rawValue(row, prop)) : (() => { const c = computed(row, prop, ctx); return !('error' in c) && c.value === true; })();
      return rule.op === 'checked' ? a : rule.op === 'unchecked' ? !a : true;
    }
    case 'select': {
      const o = optionFor(prop, rawValue(row, prop));
      const target = optionFor(prop, v);
      const same = !!o && !!target && o.name === target.name;
      return rule.op === 'is' ? same : rule.op === 'is_not' ? !same : true;
    }
    case 'multi': {
      const names = optionsFor(prop, rawValue(row, prop)).map(o => o.name);
      const target = optionFor(prop, v)?.name;
      const has = !!target && names.includes(target);
      return rule.op === 'contains' ? has : rule.op === 'not_contains' ? !has : true;
    }
    case 'person': {
      const ids = asList(rawValue(row, prop));
      const want = personFor(ctx, asText(v));
      const has = ids.some(id => id === want.id || personFor(ctx, id).name === want.name);
      return rule.op === 'contains' ? has : rule.op === 'not_contains' ? !has : true;
    }
    case 'relation': {
      const has = relationIds(row, prop, ctx).includes(asText(v));
      return rule.op === 'contains' ? has : rule.op === 'not_contains' ? !has : true;
    }
    case 'file': return true;
    case 'date': {
      const d = dateOf(row, prop, ctx);
      const now = ctx.now;
      const W = { weekStartsOn: 1 as const };
      if (!d) return false;
      switch (rule.op) {
        case 'today': return inRange(d, now, now);
        case 'this_week': return inRange(d, startOfWeek(now, W), endOfWeek(now, W));
        case 'last_week': { const x = addWeeks(now, -1); return inRange(d, startOfWeek(x, W), endOfWeek(x, W)); }
        case 'next_week': { const x = addWeeks(now, 1); return inRange(d, startOfWeek(x, W), endOfWeek(x, W)); }
        case 'this_month': return inRange(d, startOfMonth(now), endOfMonth(now));
        case 'last_month': { const x = addMonths(now, -1); return inRange(d, startOfMonth(x), endOfMonth(x)); }
        case 'next_month': { const x = addMonths(now, 1); return inRange(d, startOfMonth(x), endOfMonth(x)); }
        case 'past': return startOfDay(d.end) < startOfDay(now);
        case 'future': return startOfDay(d.start) > startOfDay(now);
        case 'past_days': { const n = asNumber(v) ?? 0; return inRange(d, addDays(now, -n), now); }
        case 'next_days': { const n = asNumber(v) ?? 0; return inRange(d, now, addDays(now, n)); }
      }
      const t = parseDateInput(v);
      if (!t || !isValid(t)) return true;
      const s = differenceInCalendarDays(d.start, t), e = differenceInCalendarDays(d.end, t);
      switch (rule.op) {
        case 'is': return s <= 0 && e >= 0;
        case 'before': return s < 0;
        case 'after': return e > 0;
        case 'on_or_before': return s <= 0;
        case 'on_or_after': return e >= 0;
      }
      return true;
    }
  }
  return true;
}

export function applyFilters(rows: Page[], view: Pick<ViewX, 'filters' | 'filterMode'>, ctx: EngineCtx): Page[] {
  const active = (view.filters ?? [])
    .map(r => ({ rule: r, prop: ctx.schema.properties.find(p => p.id === r.propId) }))
    .filter((x): x is { rule: FilterRule; prop: PropDef } => ruleIsActive(x.rule, x.prop, ctx, rows))
    .map(x => ({ ...x, kind: kindOf(x.prop, ctx, rows) }));
  if (!active.length) return rows;
  const or = view.filterMode === 'or';
  return rows.filter(row => (or
    ? active.some(a => matchRule(row, a.rule, a.prop, ctx, a.kind))
    : active.every(a => matchRule(row, a.rule, a.prop, ctx, a.kind))));
}

/** Recherche plein texte (titre + propriétés textuelles), insensible aux accents. */
export function applySearch(rows: Page[], query: string, ctx: EngineCtx): Page[] {
  const q = norm(query.trim()); if (!q) return rows;
  const props = ctx.schema.properties.filter(p => p.type !== 'file' && p.type !== 'created_time' && p.type !== 'updated_time');
  return rows.filter(r => props.some(p => norm(displayValue(r, p, ctx)).includes(q)));
}

// ── Tris ─────────────────────────────────────────────────────
type Key = number | string | null;
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function sortKey(row: Page, prop: PropDef, ctx: EngineCtx): Key {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'number': return asNumber(raw);
    case 'checkbox': return asBool(raw) ? 1 : 0;
    case 'select': case 'status': {
      const o = optionFor(prop, raw); if (!o) return null;
      const i = (prop.options ?? []).findIndex(x => x.name === o.name);
      return i < 0 ? 1e6 : i;
    }
    case 'date': { const r = readDate(raw); return r ? r.start.getTime() : null; }
    case 'created_time': return row.createdAt;
    case 'updated_time': return row.updatedAt;
    case 'formula': case 'rollup': {
      let v: FValue;
      try { v = formulaValue(row, prop, ctx); } catch { return null; }
      if (Array.isArray(v)) v = v.length ? (v[0] as FValue) : null;
      if (v === null || v === '') return null;
      if (v instanceof Date) return v.getTime();
      if (typeof v === 'boolean') return v ? 1 : 0;
      return typeof v === 'number' ? v : String(v);
    }
    case 'file': { const f = asFiles(raw); return f.length ? f.map(x => x.name).join(', ') : null; }
    default: { const s = displayValue(row, prop, ctx); return s ? s : null; }
  }
}

function cmp(a: Key, b: Key): number {
  if (a === null && b === null) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** Tri multi-critères stable ; vides toujours en dernier ; sinon ordre manuel. */
export function applySorts(rows: Page[], sorts: SortRule[], ctx: EngineCtx): Page[] {
  const valid = (sorts ?? []).map(s => ({ s, p: ctx.schema.properties.find(p => p.id === s.propId) })).filter((x): x is { s: SortRule; p: PropDef } => !!x.p);
  if (!valid.length) return [...rows].sort((a, b) => a.order - b.order);
  const keyed = rows.map(r => ({ r, k: valid.map(v => sortKey(r, v.p, ctx)) }));
  keyed.sort((x, y) => {
    for (let i = 0; i < valid.length; i++) {
      const a = x.k[i], b = y.k[i];
      if (a === null && b === null) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const c = cmp(a, b);
      if (c) return valid[i].s.dir === 'desc' ? -c : c;
    }
    return x.r.order - y.r.order;
  });
  return keyed.map(x => x.r);
}

// ── Groupement ───────────────────────────────────────────────
export const EMPTY_GROUP = '__empty__';
export interface Group { key: string; label: string; color?: string; rows: Page[]; empty?: boolean }
export const GROUPABLE: PropDef['type'][] = ['select', 'status', 'multi_select', 'checkbox', 'person'];
export const BOARDABLE: PropDef['type'][] = ['select', 'status', 'checkbox', 'person'];

/** Clés de groupe d'une ligne (plusieurs pour une sélection multiple / plusieurs personnes). */
export function groupKeys(row: Page, prop: PropDef, ctx: EngineCtx): string[] {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'select': case 'status': { const o = optionFor(prop, raw); return [o ? o.name : EMPTY_GROUP]; }
    case 'multi_select': { const os = optionsFor(prop, raw); return os.length ? os.map(o => o.name) : [EMPTY_GROUP]; }
    case 'checkbox': return [asBool(raw) ? 'true' : 'false'];
    case 'person': { const ids = asList(raw).map(id => personFor(ctx, id).id); return ids.length ? ids : [EMPTY_GROUP]; }
    default: return [EMPTY_GROUP];
  }
}

export function groupRows(rows: Page[], prop: PropDef, ctx: EngineCtx, opts: { hideEmpty?: boolean } = {}): Group[] {
  const groups: Group[] = [];
  const emptyLabel = prop.type === 'person' ? 'Aucune personne' : `Sans ${prop.name.toLowerCase()}`;
  if (prop.type === 'checkbox') {
    groups.push({ key: 'true', label: 'Cochée', rows: [] }, { key: 'false', label: 'Non cochée', rows: [] });
  } else if (prop.type === 'person') {
    const seen = new Set<string>();
    for (const r of rows) for (const k of groupKeys(r, prop, ctx)) if (k !== EMPTY_GROUP) seen.add(k);
    for (const p of ctx.people) if (seen.has(p.id)) groups.push({ key: p.id, label: p.name, color: p.color, rows: [] });
    for (const k of seen) if (!groups.some(g => g.key === k)) groups.push({ key: k, label: personFor(ctx, k).name, rows: [] });
  } else {
    for (const o of prop.options ?? []) groups.push({ key: o.name, label: o.name, color: o.color, rows: [] });
  }
  const empty: Group = { key: EMPTY_GROUP, label: emptyLabel, rows: [], empty: true };
  for (const r of rows) {
    for (const k of groupKeys(r, prop, ctx)) {
      if (k === EMPTY_GROUP) { empty.rows.push(r); continue; }
      let g = groups.find(x => x.key === k);
      if (!g) { g = { key: k, label: k, color: 'default', rows: [] }; groups.push(g); }
      g.rows.push(r);
    }
  }
  if (prop.type !== 'checkbox') groups.unshift(empty);
  return opts.hideEmpty ? groups.filter(g => g.rows.length > 0) : groups;
}

/** Valeur à écrire pour placer une ligne dans un groupe. */
export function valueForGroup(prop: PropDef, key: string, current: unknown): unknown {
  switch (prop.type) {
    case 'select': case 'status': return key === EMPTY_GROUP ? null : key;
    case 'checkbox': return key === 'true';
    case 'person': return key === EMPTY_GROUP ? [] : [key];
    case 'multi_select': {
      if (key === EMPTY_GROUP) return [];
      const cur = asList(current);
      return cur.includes(key) ? cur : [...cur, key];
    }
  }
  return current;
}

/** Valeurs à pré-remplir pour une nouvelle ligne selon les filtres « est / contient » actifs. */
export function prefillFromFilters(view: Pick<ViewX, 'filters' | 'filterMode'>, ctx: EngineCtx): Record<string, unknown> {
  if (view.filterMode === 'or') return {};
  const out: Record<string, unknown> = {};
  for (const r of view.filters ?? []) {
    const p = ctx.schema.properties.find(x => x.id === r.propId);
    if (!p || isBlank(r.value) && r.op !== 'checked') continue;
    if ((p.type === 'select' || p.type === 'status') && r.op === 'is') out[p.id] = optionFor(p, r.value)?.name;
    else if (p.type === 'multi_select' && r.op === 'contains') out[p.id] = [optionFor(p, r.value)?.name];
    else if (p.type === 'checkbox' && r.op === 'checked') out[p.id] = true;
    else if (p.type === 'person' && r.op === 'contains') out[p.id] = [asText(r.value)];
    else if (p.type === 'relation' && r.op === 'contains') out[p.id] = [asText(r.value)];
    else if ((p.type === 'text' || p.type === 'url' || p.type === 'email' || p.type === 'phone') && r.op === 'is') out[p.id] = asText(r.value);
    else if (p.type === 'title' && r.op === 'is') out.title = asText(r.value);
    else if (p.type === 'number' && r.op === 'eq') out[p.id] = asNumber(r.value);
    else if (p.type === 'date' && r.op === 'is') out[p.id] = asText(r.value);
  }
  return out;
}

// ── Calculs (pied de tableau) ────────────────────────────────
export const CALC_LABELS: Record<CalcFn, string> = {
  none: 'Aucun', count_all: 'Tout compter', count_values: 'Compter les valeurs', count_unique: 'Compter les uniques',
  count_empty: 'Compter les vides', count_not_empty: 'Compter les non vides', percent_empty: '% vides',
  percent_not_empty: '% non vides', sum: 'Somme', avg: 'Moyenne', median: 'Médiane', min: 'Min', max: 'Max',
  range: 'Étendue', checked: 'Cochées', unchecked: 'Non cochées', percent_checked: '% cochées',
  earliest: 'Plus ancienne', latest: 'Plus récente', date_range: 'Plage de dates',
};
const SHORT: Partial<Record<CalcFn, string>> = {
  count_all: 'Total', count_values: 'Valeurs', count_unique: 'Uniques', count_empty: 'Vides', count_not_empty: 'Non vides',
  percent_empty: 'Vides', percent_not_empty: 'Non vides', checked: 'Cochées', unchecked: 'Non cochées', percent_checked: 'Cochées',
  earliest: 'Plus ancienne', latest: 'Plus récente', date_range: 'Plage',
};
export const calcShortLabel = (fn: CalcFn) => SHORT[fn] ?? CALC_LABELS[fn];

export function calcsFor(prop: PropDef, ctx?: EngineCtx, rows?: Page[]): CalcFn[] {
  const base: CalcFn[] = ['none', 'count_all', 'count_values', 'count_unique', 'count_empty', 'count_not_empty', 'percent_empty', 'percent_not_empty'];
  const k = kindOf(prop, ctx, rows);
  if (k === 'checkbox') return ['none', 'count_all', 'checked', 'unchecked', 'percent_checked'];
  if (k === 'number') return [...base, 'sum', 'avg', 'median', 'min', 'max', 'range'];
  if (k === 'date') return [...base, 'earliest', 'latest', 'date_range'];
  return base;
}

export function computeCalc(fn: CalcFn, rows: Page[], prop: PropDef, ctx: EngineCtx): string {
  if (fn === 'none') return '';
  const n = rows.length;
  const pct = (x: number) => (n ? `${Math.round((x / n) * 1000) / 10} %` : '0 %');
  const empties = () => rows.filter(r => isEmptyValue(r, prop, ctx)).length;
  const fmtNum = (x: number) => formatNumber(Math.round(x * 1e8) / 1e8, prop.type === 'number' ? prop : prop.type === 'rollup' ? rollupNumberProp(prop, ctx) : undefined);
  switch (fn) {
    case 'count_all': return String(n);
    case 'count_values': {
      if (prop.type === 'multi_select') return String(rows.reduce((s, r) => s + optionsFor(prop, rawValue(r, prop)).length, 0));
      if (prop.type === 'person' || prop.type === 'relation') return String(rows.reduce((s, r) => s + relationIds(r, prop, ctx).length, 0));
      if (prop.type === 'file') return String(rows.reduce((s, r) => s + asFiles(rawValue(r, prop)).length, 0));
      return String(n - empties());
    }
    case 'count_unique': {
      const set = new Set<string>();
      for (const r of rows) {
        if (prop.type === 'multi_select') optionsFor(prop, rawValue(r, prop)).forEach(o => set.add(o.name));
        else if (prop.type === 'person' || prop.type === 'relation') relationIds(r, prop, ctx).forEach(i => set.add(i));
        else { const t = displayValue(r, prop, ctx); if (t) set.add(t); }
      }
      return String(set.size);
    }
    case 'count_empty': return String(empties());
    case 'count_not_empty': return String(n - empties());
    case 'percent_empty': return pct(empties());
    case 'percent_not_empty': return pct(n - empties());
    case 'checked': case 'unchecked': case 'percent_checked': {
      const c = rows.filter(r => (prop.type === 'checkbox' ? asBool(rawValue(r, prop)) : (() => { const v = computed(r, prop, ctx); return !('error' in v) && v.value === true; })())).length;
      return fn === 'checked' ? String(c) : fn === 'unchecked' ? String(n - c) : pct(c);
    }
    case 'sum': case 'avg': case 'median': case 'min': case 'max': case 'range': {
      const nums = rows.map(r => numberOf(r, prop, ctx)).filter((x): x is number => x !== null).sort((a, b) => a - b);
      if (!nums.length) return fn === 'sum' ? fmtNum(0) : '—';
      const sum = nums.reduce((s, x) => s + x, 0);
      switch (fn) {
        case 'sum': return fmtNum(sum);
        case 'avg': return fmtNum(sum / nums.length);
        case 'median': { const m = nums.length >> 1; return fmtNum(nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2); }
        case 'min': return fmtNum(nums[0]);
        case 'max': return fmtNum(nums[nums.length - 1]);
        default: return fmtNum(nums[nums.length - 1] - nums[0]);
      }
    }
    case 'earliest': case 'latest': case 'date_range': {
      const ds = rows.map(r => dateOf(r, prop, ctx)).filter((x): x is { start: Date; end: Date } => !!x);
      if (!ds.length) return '—';
      const min = new Date(Math.min(...ds.map(d => d.start.getTime())));
      const max = new Date(Math.max(...ds.map(d => d.end.getTime())));
      if (fn === 'earliest') return formatFValue(min);
      if (fn === 'latest') return formatFValue(max);
      const days = differenceInCalendarDays(max, min);
      return days >= 60 ? `${Math.round(days / 30.4)} mois` : `${days} jour${days > 1 ? 's' : ''}`;
    }
  }
  return '';
}
