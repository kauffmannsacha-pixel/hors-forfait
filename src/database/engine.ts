// Moteur de valeurs : lecture brute, normalisation par type, formules, rollups, texte d'affichage.
// Pur (aucune dépendance React/Tauri) → testable.
import type { ID, Page, SelectOption } from '../db/types';
import { formatDateRange, formatTimestamp, readDate } from './dates';
import { FormulaError, fToString, parseNumberLoose, rangeEnds, runFormula, type FValue } from './formula';
import { findProp, type FileRef, type Person, type PropDef, type Schema } from './model';

export interface EngineCtx {
  schema: Schema;
  getSchema: (id: ID) => Schema | undefined;
  getPage: (id: ID) => Page | undefined;
  people: Person[];
  now: Date;
  /** Cache formules/rollups (clé rowId:propId), partagé pendant un rendu. */
  memo: Map<string, FValue | FormulaError>;
}

export function makeCtx(schema: Schema, opts: { getSchema: (id: ID) => Schema | undefined; getPage: (id: ID) => Page | undefined; people?: Person[]; now?: Date }): EngineCtx {
  return { schema, getSchema: opts.getSchema, getPage: opts.getPage, people: opts.people ?? [], now: opts.now ?? new Date(), memo: new Map() };
}
/** Contexte pour une autre base (relations / rollups), cache partagé. */
export const ctxFor = (ctx: EngineCtx, schema: Schema): EngineCtx => (schema.id === ctx.schema.id ? ctx : { ...ctx, schema });

// ── Lecture brute & normalisation ────────────────────────────
export function rawValue(row: Page, prop: PropDef): unknown {
  switch (prop.type) {
    case 'title': return row.title;
    case 'created_time': return row.createdAt;
    case 'updated_time': return row.updatedAt;
    default: return row.props?.[prop.id];
  }
}
export const alive = (p: Page | undefined): p is Page => !!p && !p.trashed;

export function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
  return '';
}
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseNumberLoose(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}
const TRUTHY = ['oui', 'yes', 'true', 'vrai', '1', 'x', '✓', '✔', '✅', 'ok', 'fait', 'done', 'checked', 'coché', 'coche'];
export function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return TRUTHY.includes(v.trim().toLowerCase());
  return false;
}
/** Liste de chaînes (ids de personnes/lignes, noms d'options…). */
export function asList(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x && 'id' in x ? String((x as { id: unknown }).id) : asText(x))).filter(Boolean);
  if (typeof v === 'string') return [v];
  return [asText(v)].filter(Boolean);
}
export function asFiles(v: unknown): FileRef[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out: FileRef[] = [];
  for (const x of arr) {
    if (!x) continue;
    if (typeof x === 'string') {
      if (/^[a-f0-9]{64}$/i.test(x)) out.push({ hash: x, name: x.slice(0, 10) });
      else out.push({ url: x, name: x.split(/[/?#]/).filter(Boolean).pop() ?? x });
    } else if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      out.push({ hash: o.hash as string | undefined, url: (o.url ?? o.path) as string | undefined, name: String(o.name ?? o.hash ?? o.url ?? 'Fichier'), mime: o.mime as string | undefined });
    }
  }
  return out;
}

/** Option d'une sélection pour une valeur (nom ou id ; option « fantôme » si inconnue). */
export function optionFor(prop: PropDef, v: unknown): SelectOption | null {
  const s = asText(v).trim(); if (!s) return null;
  const opts = prop.options ?? [];
  return opts.find(o => o.name === s) ?? opts.find(o => o.id === s) ?? opts.find(o => o.name.toLowerCase() === s.toLowerCase()) ?? { id: s, name: s, color: 'default' };
}
/** Valeurs (noms d'options) d'une sélection multiple. */
export function optionsFor(prop: PropDef, v: unknown): SelectOption[] {
  const list = Array.isArray(v) ? asList(v) : typeof v === 'string' && v.includes(',') && !(prop.options ?? []).some(o => o.name === v) ? v.split(',').map(s => s.trim()) : asList(v);
  const out: SelectOption[] = [];
  for (const x of list) { const o = optionFor(prop, x); if (o && !out.some(y => y.name === o.name)) out.push(o); }
  return out;
}
export const personFor = (ctx: Pick<EngineCtx, 'people'>, idOrName: string): Person =>
  ctx.people.find(p => p.id === idOrName) ?? ctx.people.find(p => p.name.toLowerCase() === idOrName.toLowerCase()) ?? { id: idOrName, name: idOrName, color: 'default' };

export function isEmptyValue(row: Page, prop: PropDef, ctx: EngineCtx): boolean {
  switch (prop.type) {
    case 'checkbox': return !asBool(rawValue(row, prop));
    case 'formula': case 'rollup': {
      const r = computed(row, prop, ctx);
      return 'error' in r || r.value === null || r.value === '' || (Array.isArray(r.value) && r.value.length === 0);
    }
    case 'created_time': case 'updated_time': return false;
    case 'multi_select': return optionsFor(prop, rawValue(row, prop)).length === 0;
    case 'person': case 'relation': return relationIds(row, prop, ctx).length === 0;
    case 'file': return asFiles(rawValue(row, prop)).length === 0;
    case 'date': return !readDate(rawValue(row, prop));
    case 'number': return asNumber(rawValue(row, prop)) === null;
    default: return asText(rawValue(row, prop)).trim() === '';
  }
}

/** Ids liés (relation : lignes vivantes ; personne : ids/noms). */
export function relationIds(row: Page, prop: PropDef, ctx: Pick<EngineCtx, 'getPage'>): string[] {
  const ids = asList(rawValue(row, prop));
  return prop.type === 'relation' ? ids.filter(id => alive(ctx.getPage(id))) : ids;
}

// ── Valeurs « formule » (utilisées par prop(), filtres, tris, rollups) ──
export function formulaValue(row: Page, prop: PropDef, ctx: EngineCtx, stack: string[] = []): FValue {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'title': case 'text': case 'url': case 'email': case 'phone': return asText(raw);
    case 'number': return asNumber(raw);
    case 'select': case 'status': return optionFor(prop, raw)?.name ?? '';
    case 'multi_select': return optionsFor(prop, raw).map(o => o.name);
    case 'date': {
      const r = readDate(raw); if (!r) return null;
      const d = new Date(r.start.getTime()); if (r.end) rangeEnds.set(d, r.end);
      return d;
    }
    case 'person': return asList(raw).map(id => personFor(ctx, id).name);
    case 'checkbox': return asBool(raw);
    case 'file': return asFiles(raw).map(f => f.name);
    case 'relation': return relationIds(row, prop, ctx).map(id => ctx.getPage(id)?.title || 'Sans titre');
    case 'created_time': return new Date(row.createdAt);
    case 'updated_time': return new Date(row.updatedAt);
    case 'formula': case 'rollup': {
      const key = row.id + ':' + prop.id;
      const cached = ctx.memo.get(key);
      if (cached !== undefined) { if (cached instanceof FormulaError) throw cached; return cached; }
      if (stack.includes(key)) throw new FormulaError(`Référence circulaire : « ${prop.name} » dépend d’elle-même`);
      let v: FValue | FormulaError;
      try { v = prop.type === 'formula' ? evalFormula(row, prop, ctx, [...stack, key]) : evalRollup(row, prop, ctx, [...stack, key]); }
      catch (e) { v = e instanceof FormulaError ? e : new FormulaError(String((e as Error).message ?? e)); }
      ctx.memo.set(key, v);
      if (v instanceof FormulaError) throw v;
      return v;
    }
  }
  return null;
}

function evalFormula(row: Page, prop: PropDef, ctx: EngineCtx, stack: string[]): FValue {
  const src = prop.formula ?? '';
  if (!src.trim()) return null;
  const r = runFormula(src, {
    prop: name => {
      const def = findProp(ctx.schema, name);
      if (!def || (def.name !== name && def.name.trim().toLowerCase() !== name.trim().toLowerCase())) throw new FormulaError(`Propriété introuvable : « ${name} »`);
      return formulaValue(row, def, ctx, stack);
    },
    now: () => ctx.now, id: row.id,
  });
  if (r.error !== undefined) throw new FormulaError(r.error);
  return r.value;
}

function evalRollup(row: Page, prop: PropDef, ctx: EngineCtx, stack: string[]): FValue {
  const conf = prop.rollup;
  if (!conf?.relationPropId) throw new FormulaError('Rollup à configurer : choisis une relation');
  const rel = ctx.schema.properties.find(p => p.id === conf.relationPropId);
  if (!rel || rel.type !== 'relation') throw new FormulaError('Rollup : la relation n’existe plus');
  const linked = relationIds(row, rel, ctx).map(id => ctx.getPage(id)).filter(alive);
  if (conf.fn === 'count') return linked.length;
  const target = rel.relation?.databaseId ? ctx.getSchema(rel.relation.databaseId) : undefined;
  if (!target) return null; // base liée pas encore chargée
  const tp = target.properties.find(p => p.id === conf.targetPropId);
  if (!tp) throw new FormulaError('Rollup : choisis la propriété à agréger');
  const tctx = ctxFor(ctx, target);
  const values = linked.map(r => formulaValue(r, tp, tctx, stack));
  return aggregate(conf.fn, values);
}

export function aggregate(fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'show', values: FValue[]): FValue {
  const flat = values.flatMap(v => (Array.isArray(v) ? v : [v])).filter(v => v !== null && v !== '');
  switch (fn) {
    case 'count': return values.length;
    case 'show': return flat;
    case 'sum': return flat.reduce<number>((s, v) => s + (asNumber(v instanceof Date ? null : v) ?? 0), 0);
    case 'avg': {
      const n = flat.map(v => asNumber(v instanceof Date ? null : v)).filter((x): x is number => x !== null);
      return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null;
    }
    case 'min': case 'max': {
      const dates = flat.filter((v): v is Date => v instanceof Date);
      if (dates.length && dates.length === flat.length) {
        const t = dates.map(d => d.getTime()); return new Date(fn === 'min' ? Math.min(...t) : Math.max(...t));
      }
      const n = flat.map(v => asNumber(v instanceof Date ? null : v)).filter((x): x is number => x !== null);
      return n.length ? (fn === 'min' ? Math.min(...n) : Math.max(...n)) : null;
    }
  }
}

/** Valeur calculée sûre (formule/rollup) : jamais d'exception. */
export function computed(row: Page, prop: PropDef, ctx: EngineCtx): { value: FValue } | { error: string } {
  try { return { value: formulaValue(row, prop, ctx) }; }
  catch (e) { return { error: e instanceof FormulaError ? e.message : String(e) }; }
}

// ── Affichage ────────────────────────────────────────────────
const nf = new Map<string, Intl.NumberFormat>();
function numberFormatter(key: string, make: () => Intl.NumberFormat) { let f = nf.get(key); if (!f) { f = make(); nf.set(key, f); } return f; }

export function formatNumber(n: number | null, prop?: Pick<PropDef, 'numberFormat' | 'decimals'>): string {
  if (n === null || !Number.isFinite(n)) return n === null ? '' : String(n);
  const fmt = prop?.numberFormat ?? 'number';
  const d = prop?.decimals;
  const dec = d === undefined ? {} : { minimumFractionDigits: d, maximumFractionDigits: d };
  switch (fmt) {
    case 'euro': return numberFormatter('eur' + d, () => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', ...dec })).format(n);
    case 'dollar': return numberFormatter('usd' + d, () => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', ...dec })).format(n);
    case 'percent': return numberFormatter('pct' + d, () => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d ?? 2, ...dec })).format(n) + ' %';
    default: return numberFormatter('num' + d, () => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d ?? 6, ...dec })).format(n);
  }
}

/** Formate une valeur de formule/rollup. `numberProp` donne le format numérique (rollup). */
export function formatFValue(v: FValue, numberProp?: Pick<PropDef, 'numberFormat' | 'decimals'>): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(Math.round(v * 1e10) / 1e10, numberProp);
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (v instanceof Date) {
    const end = rangeEnds.get(v);
    return formatDateRange({ start: v, end: end ?? null, hasTime: v.getHours() !== 0 || v.getMinutes() !== 0 });
  }
  if (Array.isArray(v)) return v.map(x => formatFValue(x, numberProp)).filter(Boolean).join(', ');
  return fToString(v);
}

/** Format numérique à appliquer au résultat d'un rollup (celui de la propriété cible). */
export function rollupNumberProp(prop: PropDef, ctx: EngineCtx): PropDef | undefined {
  if (prop.type !== 'rollup' || !prop.rollup || prop.rollup.fn === 'count') return undefined;
  const rel = ctx.schema.properties.find(p => p.id === prop.rollup!.relationPropId);
  const target = rel?.relation?.databaseId ? ctx.getSchema(rel.relation.databaseId) : undefined;
  const tp = target?.properties.find(p => p.id === prop.rollup!.targetPropId);
  return tp?.type === 'number' ? tp : undefined;
}

/** Texte lisible d'une cellule (recherche, conversions, Claude, export). */
export function displayValue(row: Page, prop: PropDef, ctx: EngineCtx): string {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'title': case 'text': case 'url': case 'email': case 'phone': return asText(raw);
    case 'number': return formatNumber(asNumber(raw), prop);
    case 'select': case 'status': return optionFor(prop, raw)?.name ?? '';
    case 'multi_select': return optionsFor(prop, raw).map(o => o.name).join(', ');
    case 'date': return formatDateRange(readDate(raw), prop.dateFormat, prop.timeFormat, ctx.now);
    case 'person': return asList(raw).map(id => personFor(ctx, id).name).join(', ');
    case 'checkbox': return asBool(raw) ? 'Oui' : 'Non';
    case 'file': return asFiles(raw).map(f => f.name).join(', ');
    case 'relation': return relationIds(row, prop, ctx).map(id => ctx.getPage(id)?.title || 'Sans titre').join(', ');
    case 'created_time': case 'updated_time': return formatTimestamp(Number(raw), prop.dateFormat, prop.timeFormat);
    case 'formula': case 'rollup': {
      const r = computed(row, prop, ctx);
      return 'error' in r ? '' : formatFValue(r.value, prop.type === 'rollup' ? rollupNumberProp(prop, ctx) : prop);
    }
  }
  return '';
}

/** Valeur « simple » exportable (JSON) : noms d'options, dates ISO, titres liés… */
export function plainValue(row: Page, prop: PropDef, ctx: EngineCtx): unknown {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'title': case 'text': case 'url': case 'email': case 'phone': return asText(raw);
    case 'number': return asNumber(raw);
    case 'select': case 'status': return optionFor(prop, raw)?.name ?? null;
    case 'multi_select': return optionsFor(prop, raw).map(o => o.name);
    case 'date': { const r = readDate(raw); return r ? (r.end ? { start: r.start.toISOString(), end: r.end.toISOString() } : r.start.toISOString()) : null; }
    case 'person': return asList(raw).map(id => personFor(ctx, id).name);
    case 'checkbox': return asBool(raw);
    case 'file': return asFiles(raw).map(f => f.name);
    case 'relation': return relationIds(row, prop, ctx).map(id => ({ id, title: ctx.getPage(id)?.title ?? '' }));
    case 'created_time': case 'updated_time': return new Date(Number(raw)).toISOString();
    case 'formula': case 'rollup': {
      const r = computed(row, prop, ctx);
      if ('error' in r) return { erreur: r.error };
      const v = r.value;
      return v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(x => (x instanceof Date ? x.toISOString() : x)) : v;
    }
  }
  return raw ?? null;
}

/** Nature d'une valeur (pour choisir filtres / tris / calculs). */
export type ValueKind = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'multi' | 'person' | 'file' | 'relation';
export function kindOf(prop: PropDef, ctx?: EngineCtx, rows?: Page[]): ValueKind {
  switch (prop.type) {
    case 'number': return 'number';
    case 'select': case 'status': return 'select';
    case 'multi_select': return 'multi';
    case 'date': case 'created_time': case 'updated_time': return 'date';
    case 'checkbox': return 'checkbox';
    case 'person': return 'person';
    case 'file': return 'file';
    case 'relation': return 'relation';
    case 'rollup': {
      const fn = prop.rollup?.fn;
      if (fn === 'count' || fn === 'sum' || fn === 'avg') return 'number';
      if (fn === 'show') return 'text';
      break;
    }
    case 'formula': break;
    default: return 'text';
  }
  // Formule / rollup min-max : on déduit du premier résultat non vide.
  if (ctx && rows) {
    for (const r of rows.slice(0, 50)) {
      const c = computed(r, prop, ctx);
      if ('error' in c || c.value === null || c.value === '') continue;
      const v = Array.isArray(c.value) ? c.value[0] : c.value;
      if (typeof v === 'number') return 'number';
      if (typeof v === 'boolean') return 'checkbox';
      if (v instanceof Date) return 'date';
      return 'text';
    }
  }
  return prop.type === 'rollup' ? 'number' : 'text';
}
