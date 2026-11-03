// Moteur de formules façon Notion — tokeniseur + parser de Pratt + évaluateur. Aucun eval().
// Syntaxe : prop("Nom"), + - * / % ^, == != < > <= >=, and/or/not (&& || !), a ? b : c,
// appels de fonctions (if, concat, dateAdd…) et appels chaînés façon Notion 2 : prop("Nom").length().
import {
  add, addMilliseconds, differenceInDays, differenceInHours, differenceInMilliseconds, differenceInMinutes,
  differenceInMonths, differenceInQuarters, differenceInSeconds, differenceInWeeks, differenceInYears,
  format as dfFormat, getISOWeek, isValid, startOfDay,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { parseDateInput } from './dates';

export type FValue = number | string | boolean | Date | null | FValue[];

export class FormulaError extends Error {
  pos?: number;
  constructor(message: string, pos?: number) { super(message); this.name = 'FormulaError'; this.pos = pos; }
}

/** Fin de plage des dates issues d'une propriété date avec plage (pour end()). */
export const rangeEnds = new WeakMap<Date, Date>();

// ── Tokeniseur ───────────────────────────────────────────────
type Tok =
  | { t: 'num'; v: number; p: number } | { t: 'str'; v: string; p: number }
  | { t: 'id'; v: string; p: number } | { t: 'op'; v: string; p: number } | { t: 'eof'; p: number };

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '≠', '≤', '≥', '+', '-', '*', '/', '%', '^', '(', ')', '[', ']', ',', ';', '<', '>', '=', '!', '?', ':', '.'];
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '«': '»', '‘': '’' };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new FormulaError('Commentaire non fermé : il manque « */ »', i);
      i = end + 2; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: parseFloat(m[0]), p: i }); i += m[0].length; continue;
    }
    if (QUOTES[c]) {
      const close = QUOTES[c]; let j = i + 1, s = '';
      while (j < src.length && src[j] !== close) {
        if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; }
        else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError(`Texte non fermé : il manque ${close}`, i);
      out.push({ t: 'str', v: c === '«' ? s.trim() : s, p: i }); i = j + 1; continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      const m = /^[\p{L}\p{N}_$]+/u.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], p: i }); i += m[0].length; continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Caractère inattendu « ${c} »`, i);
    out.push({ t: 'op', v: op, p: i }); i += op.length;
  }
  out.push({ t: 'eof', p: src.length });
  return out;
}

// ── Parser (Pratt) ───────────────────────────────────────────
export type Node =
  | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'bool'; v: boolean }
  | { k: 'list'; items: Node[] }
  | { k: 'un'; op: string; a: Node; p: number }
  | { k: 'bin'; op: string; a: Node; b: Node; p: number }
  | { k: 'tern'; c: Node; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[]; p: number };

const tokText = (t: Tok) => t.t === 'eof' ? 'fin de formule' : t.t === 'str' ? `"${t.v}"` : String(t.v);

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}
  private peek() { return this.toks[this.i]; }
  private next() { return this.toks[this.i++]; }
  private isOp(v: string) { const t = this.peek(); return t.t === 'op' && t.v === v; }
  private expect(v: string, what?: string) {
    const t = this.peek();
    if (!this.isOp(v)) {
      throw new FormulaError(t.t === 'eof' ? `Fin de formule inattendue : « ${v} » attendu${what ? ' ' + what : ''}` : `« ${v} » attendu${what ? ' ' + what : ''} au lieu de « ${tokText(t)} »`, t.p);
    }
    this.next();
  }
  parse(): Node {
    if (this.peek().t === 'eof') throw new FormulaError('La formule est vide', 0);
    const n = this.expr(0);
    const t = this.peek();
    if (t.t !== 'eof') throw new FormulaError(`Symbole inattendu « ${tokText(t)} »`, t.p);
    return n;
  }
  private binary(): { op: string; prec: number; right?: boolean } | null {
    const t = this.peek();
    if (t.t === 'op') {
      switch (t.v) {
        case '?': return { op: '?', prec: 1, right: true };
        case '||': return { op: 'or', prec: 2 };
        case '&&': return { op: 'and', prec: 3 };
        case '==': case '=': return { op: '==', prec: 5 };
        case '!=': case '≠': return { op: '!=', prec: 5 };
        case '<': case '>': case '<=': case '>=': return { op: t.v, prec: 6 };
        case '≤': return { op: '<=', prec: 6 };
        case '≥': return { op: '>=', prec: 6 };
        case '+': case '-': return { op: t.v, prec: 7 };
        case '*': case '/': case '%': return { op: t.v, prec: 8 };
        case '^': return { op: '^', prec: 10, right: true };
      }
    }
    if (t.t === 'id') {
      const v = t.v.toLowerCase();
      if (v === 'and' || v === 'et') return { op: 'and', prec: 3 };
      if (v === 'or' || v === 'ou') return { op: 'or', prec: 2 };
    }
    return null;
  }
  private expr(min: number): Node {
    let left = this.unary();
    for (;;) {
      const b = this.binary();
      if (!b || b.prec < min) break;
      const t = this.next();
      if (b.op === '?') {
        const a = this.expr(0);
        this.expect(':', 'dans la condition « ? : »');
        const c = this.expr(b.prec);
        left = { k: 'tern', c: left, a, b: c };
        continue;
      }
      const right = this.expr(b.right ? b.prec : b.prec + 1);
      left = { k: 'bin', op: b.op, a: left, b: right, p: t.p };
    }
    return left;
  }
  private unary(): Node {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      this.next();
      return { k: 'un', op: t.v === '!' ? 'not' : t.v, a: this.expr(t.v === '!' ? 9 : 9), p: t.p };
    }
    if (t.t === 'id' && t.v.toLowerCase() === 'not') {
      const nx = this.toks[this.i + 1];
      if (!(nx && nx.t === 'op' && nx.v === '(')) { this.next(); return { k: 'un', op: 'not', a: this.expr(4), p: t.p }; }
    }
    return this.postfix(this.primary());
  }
  private args(): Node[] {
    const args: Node[] = [];
    this.expect('(');
    if (this.isOp(')')) { this.next(); return args; }
    for (;;) {
      args.push(this.expr(0));
      if (this.isOp(',') || this.isOp(';')) { this.next(); continue; }
      this.expect(')', 'pour fermer l’appel de fonction');
      return args;
    }
  }
  private postfix(n: Node): Node {
    while (this.isOp('.')) {
      this.next();
      const t = this.next();
      if (t.t !== 'id') throw new FormulaError('Nom de fonction attendu après « . »', t.p);
      const args = this.isOp('(') ? this.args() : [];
      n = { k: 'call', name: t.v, args: [n, ...args], p: t.p };
    }
    return n;
  }
  private primary(): Node {
    const t = this.next();
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'eof': throw new FormulaError('Fin de formule inattendue : une valeur est attendue', t.p);
      case 'op':
        if (t.v === '(') { const n = this.expr(0); this.expect(')', 'pour fermer la parenthèse'); return n; }
        if (t.v === '[') {
          const items: Node[] = [];
          if (this.isOp(']')) { this.next(); return { k: 'list', items }; }
          for (;;) {
            items.push(this.expr(0));
            if (this.isOp(',') || this.isOp(';')) { this.next(); continue; }
            this.expect(']', 'pour fermer la liste'); return { k: 'list', items };
          }
        }
        throw new FormulaError(`Symbole inattendu « ${t.v} »`, t.p);
      case 'id': {
        const low = t.v.toLowerCase();
        if (this.isOp('(')) return { k: 'call', name: t.v, args: this.args(), p: t.p };
        if (low === 'true' || low === 'vrai') return { k: 'bool', v: true };
        if (low === 'false' || low === 'faux') return { k: 'bool', v: false };
        if (low === 'pi') return { k: 'num', v: Math.PI };
        if (low === 'e') return { k: 'num', v: Math.E };
        throw new FormulaError(`« ${t.v} » est inconnu. Pour une propriété, écris prop("${t.v}")`, t.p);
      }
    }
  }
}

const compiled = new Map<string, Node | FormulaError>();
/** Compile (avec cache). Lève FormulaError si la syntaxe est invalide. */
export function compile(src: string): Node {
  let n = compiled.get(src);
  if (!n) {
    try { n = new Parser(tokenize(src)).parse(); } catch (e) { n = e instanceof FormulaError ? e : new FormulaError(String(e)); }
    if (compiled.size > 800) compiled.clear();
    compiled.set(src, n);
  }
  if (n instanceof FormulaError) throw n;
  return n;
}

// ── Conversions ──────────────────────────────────────────────
export function isEmptyF(v: FValue): boolean {
  return v === null || v === undefined || v === '' || v === false || v === 0 || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v));
}
export function fToString(v: FValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e10) / 1e10) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return isValid(v) ? dfFormat(v, 'd MMMM yyyy', { locale: fr }) + (v.getHours() || v.getMinutes() ? dfFormat(v, ' HH:mm') : '') : '';
  return v.map(fToString).filter(Boolean).join(', ');
}
export function parseNumberLoose(s: string): number | null {
  const t = s.trim().replace(/[\s  ]/g, '').replace(/[€$%]/g, '');
  if (!t) return null;
  const n = Number(/^-?\d+(,\d+)?$/.test(t) ? t.replace(',', '.') : t.replace(/,(?=\d{3}(\D|$))/g, ''));
  return Number.isFinite(n) ? n : null;
}
const typeName = (v: FValue) => v === null ? 'vide' : Array.isArray(v) ? 'une liste' : v instanceof Date ? 'une date' : typeof v === 'string' ? `le texte « ${v.length > 24 ? v.slice(0, 24) + '…' : v} »` : typeof v === 'boolean' ? 'un booléen' : 'un nombre';
function toNum(v: FValue, fn: string): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') { const n = parseNumberLoose(v); if (n !== null) return n; }
  if (Array.isArray(v) && v.length === 1) return toNum(v[0], fn);
  throw new FormulaError(`${fn} attend un nombre, reçu ${typeName(v)}`);
}
export function toBool(v: FValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Date) return true;
  return !!v;
}
function toDate(v: FValue, fn: string): Date {
  if (v instanceof Date) return v;
  if (Array.isArray(v) && v.length === 1) return toDate(v[0], fn);
  const d = typeof v === 'string' || typeof v === 'number' ? parseDateInput(v) : null;
  if (d) return d;
  throw new FormulaError(`${fn} attend une date, reçu ${typeName(v)}`);
}
const flat = (args: FValue[]): FValue[] => args.flatMap(a => (Array.isArray(a) ? flat(a) : [a]));

function equals(a: FValue, b: FValue): boolean {
  if (a instanceof Date || b instanceof Date) {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return false;
  }
  if ((a === null || a === '') && (b === null || b === '')) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]));
    return fToString(a) === fToString(b);
  }
  if (typeof a === typeof b) return a === b;
  if (a === null || b === null) return false;
  return fToString(a) === fToString(b);
}
function compare(a: FValue, b: FValue, op: string): boolean {
  let x: number | string, y: number | string;
  if (a instanceof Date || b instanceof Date) {
    if (a === null || b === null) return false;
    x = toDate(a, `« ${op} »`).getTime(); y = toDate(b, `« ${op} »`).getTime();
  } else if (typeof a === 'string' && typeof b === 'string') {
    const c = a.localeCompare(b, 'fr', { numeric: true }); x = c; y = 0;
  } else { x = toNum(a, `L’opérateur « ${op} »`); y = toNum(b, `L’opérateur « ${op} »`); }
  switch (op) { case '<': return x < y; case '>': return x > y; case '<=': return x <= y; default: return x >= y; }
}

// ── Unités de temps ──────────────────────────────────────────
type Unit = 'years' | 'quarters' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds';
const UNITS: Record<string, Unit> = {
  years: 'years', year: 'years', y: 'years', 'années': 'years', 'année': 'years', annees: 'years', annee: 'years', ans: 'years', an: 'years',
  quarters: 'quarters', quarter: 'quarters', trimestres: 'quarters', trimestre: 'quarters',
  months: 'months', month: 'months', mois: 'months', M: 'months',
  weeks: 'weeks', week: 'weeks', w: 'weeks', semaines: 'weeks', semaine: 'weeks',
  days: 'days', day: 'days', d: 'days', jours: 'days', jour: 'days', j: 'days',
  hours: 'hours', hour: 'hours', h: 'hours', heures: 'hours', heure: 'hours',
  minutes: 'minutes', minute: 'minutes', min: 'minutes', m: 'minutes',
  seconds: 'seconds', second: 'seconds', s: 'seconds', secondes: 'seconds', seconde: 'seconds',
  milliseconds: 'milliseconds', millisecond: 'milliseconds', ms: 'milliseconds',
};
function unitOf(v: FValue, fn: string): Unit {
  const s = fToString(v).trim();
  const u = UNITS[s] ?? UNITS[s.toLowerCase()];
  if (!u) throw new FormulaError(`${fn} : unité inconnue « ${s} » (utilise "years", "months", "weeks", "days", "hours" ou "minutes")`);
  return u;
}
function dateShift(d: Date, n: number, u: Unit): Date {
  if (u === 'milliseconds') return addMilliseconds(d, n);
  if (u === 'quarters') return add(d, { months: n * 3 });
  return add(d, { [u]: n });
}
const DIFF: Record<Unit, (a: Date, b: Date) => number> = {
  years: differenceInYears, quarters: differenceInQuarters, months: differenceInMonths, weeks: differenceInWeeks,
  days: differenceInDays, hours: differenceInHours, minutes: differenceInMinutes, seconds: differenceInSeconds,
  milliseconds: differenceInMilliseconds,
};

/** Convertit un format façon moment.js / Notion (YYYY, DD, Do…) en format date-fns. */
export function toDateFnsFormat(f: string): string {
  return f.replace(/\[([^\]]*)\]|YYYY|YY|Do|DD|D|dddd|ddd|A|'/g, (m, lit: string | undefined) => {
    if (lit !== undefined) return `'${lit.replace(/'/g, "''")}'`;
    switch (m) {
      case 'YYYY': return 'yyyy'; case 'YY': return 'yy'; case 'Do': return 'do'; case 'DD': return 'dd'; case 'D': return 'd';
      case 'dddd': return 'EEEE'; case 'ddd': return 'EEE'; case 'A': return 'a'; case "'": return "''";
      default: return m;
    }
  });
}

// ── Évaluation ───────────────────────────────────────────────
export interface FormulaEnv {
  prop: (name: string) => FValue;
  now?: () => Date;
  id?: string;
}

function arity(name: string, args: Node[] | FValue[], min: number, max = min) {
  if (args.length < min || args.length > max) {
    const exp = min === max ? `${min} argument${min > 1 ? 's' : ''}` : max === Infinity ? `au moins ${min} argument${min > 1 ? 's' : ''}` : `${min} à ${max} arguments`;
    throw new FormulaError(`${name}() attend ${exp} (reçu ${args.length})`);
  }
}
function regex(p: FValue, flags: string, fn: string): RegExp {
  const s = fToString(p);
  try { return new RegExp(s, flags); } catch { throw new FormulaError(`${fn}() : expression régulière invalide « ${s} »`); }
}
const numOrNull = (v: number) => (Number.isFinite(v) ? v : null);

type Fn = { min: number; max?: number; run: (a: FValue[], env: FormulaEnv) => FValue };
const F: Record<string, Fn> = {
  concat: { min: 0, max: Infinity, run: a => (a.length && a.every(Array.isArray) ? (a as FValue[][]).flat() : a.map(fToString).join('')) },
  length: { min: 1, run: ([x]) => (Array.isArray(x) ? x.length : fToString(x).length) },
  contains: { min: 2, run: ([x, y]) => Array.isArray(x) ? x.some(i => equals(i, y) || (typeof i === 'string' && typeof y === 'string' && i.toLowerCase() === y.toLowerCase())) : fToString(x).includes(fToString(y)) },
  includes: { min: 2, run: (a, e) => F.contains.run(a, e) },
  replace: { min: 3, run: ([s, p, r]) => fToString(s).replace(regex(p, '', 'replace'), fToString(r)) },
  replaceall: { min: 3, run: ([s, p, r]) => fToString(s).replace(regex(p, 'g', 'replaceAll'), fToString(r)) },
  test: { min: 2, run: ([s, p]) => regex(p, '', 'test').test(fToString(s)) },
  lower: { min: 1, run: ([s]) => fToString(s).toLowerCase() },
  upper: { min: 1, run: ([s]) => fToString(s).toUpperCase() },
  trim: { min: 1, run: ([s]) => fToString(s).trim() },
  slice: { min: 2, max: 3, run: ([s, a, b]) => Array.isArray(s) ? s.slice(toNum(a, 'slice()'), b === undefined ? undefined : toNum(b, 'slice()')) : fToString(s).slice(toNum(a, 'slice()'), b === undefined ? undefined : toNum(b, 'slice()')) },
  substring: { min: 2, max: 3, run: (a, e) => F.slice.run(a, e) },
  split: { min: 1, max: 2, run: ([s, sep]) => fToString(s).split(sep === undefined ? ',' : fToString(sep)).map(x => x.trim()).filter(Boolean) },
  join: {
    min: 1, max: Infinity, run: a => Array.isArray(a[0])
      ? (a[0] as FValue[]).map(fToString).join(a[1] === undefined ? ', ' : fToString(a[1]))
      : flat(a.slice(1)).map(fToString).join(fToString(a[0])),
  },
  format: { min: 1, run: ([x]) => fToString(x) },
  tostring: { min: 1, run: ([x]) => fToString(x) },
  tonumber: {
    min: 1, run: ([x]) => {
      if (typeof x === 'number') return x;
      if (typeof x === 'boolean') return x ? 1 : 0;
      if (x instanceof Date) return x.getTime();
      if (Array.isArray(x)) return x.length ? F.tonumber.run([x[0]], {} as FormulaEnv) : null;
      return x === null ? null : parseNumberLoose(String(x));
    },
  },
  round: { min: 1, max: 2, run: ([n, d]) => { const p = 10 ** (d === undefined ? 0 : toNum(d, 'round()')); const v = toNum(n, 'round()'); return Math.sign(v) * Math.round((Math.abs(v) + Number.EPSILON) * p) / p; } },
  floor: { min: 1, run: ([n]) => Math.floor(toNum(n, 'floor()')) },
  ceil: { min: 1, run: ([n]) => Math.ceil(toNum(n, 'ceil()')) },
  abs: { min: 1, run: ([n]) => Math.abs(toNum(n, 'abs()')) },
  sign: { min: 1, run: ([n]) => Math.sign(toNum(n, 'sign()')) },
  sqrt: { min: 1, run: ([n]) => { const v = toNum(n, 'sqrt()'); if (v < 0) throw new FormulaError('sqrt() : racine d’un nombre négatif'); return Math.sqrt(v); } },
  cbrt: { min: 1, run: ([n]) => Math.cbrt(toNum(n, 'cbrt()')) },
  pow: { min: 2, run: ([a, b]) => toNum(a, 'pow()') ** toNum(b, 'pow()') },
  exp: { min: 1, run: ([n]) => Math.exp(toNum(n, 'exp()')) },
  ln: { min: 1, run: ([n]) => numOrNull(Math.log(toNum(n, 'ln()'))) },
  log10: { min: 1, run: ([n]) => numOrNull(Math.log10(toNum(n, 'log10()'))) },
  log2: { min: 1, run: ([n]) => numOrNull(Math.log2(toNum(n, 'log2()'))) },
  min: { min: 1, max: Infinity, run: a => { const n = flat(a).filter(x => x !== null && x !== '').map(x => toNum(x, 'min()')); return n.length ? Math.min(...n) : null; } },
  max: { min: 1, max: Infinity, run: a => { const n = flat(a).filter(x => x !== null && x !== '').map(x => toNum(x, 'max()')); return n.length ? Math.max(...n) : null; } },
  sum: { min: 1, max: Infinity, run: a => flat(a).reduce<number>((s, x) => s + toNum(x, 'sum()'), 0) },
  mean: { min: 1, max: Infinity, run: a => { const n = flat(a).filter(x => x !== null && x !== '').map(x => toNum(x, 'mean()')); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null; } },
  average: { min: 1, max: Infinity, run: (a, e) => F.mean.run(a, e) },
  median: {
    min: 1, max: Infinity, run: a => {
      const n = flat(a).filter(x => x !== null && x !== '').map(x => toNum(x, 'median()')).sort((x, y) => x - y);
      if (!n.length) return null; const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
    },
  },
  now: { min: 0, run: (_a, env) => env.now?.() ?? new Date() },
  today: { min: 0, run: (_a, env) => startOfDay(env.now?.() ?? new Date()) },
  dateadd: { min: 3, run: ([d, n, u]) => dateShift(toDate(d, 'dateAdd()'), toNum(n, 'dateAdd()'), unitOf(u, 'dateAdd()')) },
  datesubtract: { min: 3, run: ([d, n, u]) => dateShift(toDate(d, 'dateSubtract()'), -toNum(n, 'dateSubtract()'), unitOf(u, 'dateSubtract()')) },
  datebetween: {
    min: 3, run: ([a, b, u]) => {
      if (a === null || b === null) return null;
      const r = DIFF[unitOf(u, 'dateBetween()')](toDate(a, 'dateBetween()'), toDate(b, 'dateBetween()'));
      return r === 0 ? 0 : r;
    },
  },
  formatdate: {
    min: 1, max: 2, run: ([d, f]) => {
      if (d === null || d === '') return '';
      const date = toDate(d, 'formatDate()');
      const fmt = f === undefined ? 'd MMMM yyyy' : toDateFnsFormat(fToString(f));
      try { return dfFormat(date, fmt, { locale: fr }); } catch { throw new FormulaError(`formatDate() : format de date invalide « ${fToString(f)} »`); }
    },
  },
  parsedate: { min: 1, run: ([s]) => { const d = parseDateInput(fToString(s)); if (!d) throw new FormulaError(`parseDate() : date illisible « ${fToString(s)} »`); return d; } },
  timestamp: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'timestamp()').getTime()) },
  fromtimestamp: { min: 1, run: ([n]) => new Date(toNum(n, 'fromTimestamp()')) },
  year: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'year()').getFullYear()) },
  month: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'month()').getMonth() + 1) },
  date: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'date()').getDate()) },
  day: { min: 1, run: ([d]) => (d === null ? null : ((toDate(d, 'day()').getDay() + 6) % 7) + 1) },
  hour: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'hour()').getHours()) },
  minute: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'minute()').getMinutes()) },
  week: { min: 1, run: ([d]) => (d === null ? null : getISOWeek(toDate(d, 'week()'))) },
  start: { min: 1, run: ([d]) => (d === null ? null : toDate(d, 'start()')) },
  end: { min: 1, run: ([d]) => { if (d === null) return null; const s = toDate(d, 'end()'); return rangeEnds.get(s) ?? s; } },
  empty: { min: 1, run: ([x]) => isEmptyF(x) },
  not: { min: 1, run: ([x]) => !toBool(x) },
  at: { min: 2, run: ([l, i]) => { const arr = Array.isArray(l) ? l : [...fToString(l)]; const k = toNum(i, 'at()'); return arr.at(k) ?? null; } },
  first: { min: 1, run: ([l]) => (Array.isArray(l) ? l[0] ?? null : l) },
  last: { min: 1, run: ([l]) => (Array.isArray(l) ? l[l.length - 1] ?? null : l) },
  count: { min: 1, run: ([l]) => (Array.isArray(l) ? l.filter(x => !isEmptyF(x)).length : isEmptyF(l) ? 0 : 1) },
  sort: { min: 1, run: ([l]) => (Array.isArray(l) ? [...l].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : fToString(a).localeCompare(fToString(b), 'fr', { numeric: true }))) : l) },
  reverse: { min: 1, run: ([l]) => (Array.isArray(l) ? [...l].reverse() : [...fToString(l)].reverse().join('')) },
  unique: { min: 1, run: ([l]) => (Array.isArray(l) ? l.filter((x, i) => l.findIndex(y => equals(x, y)) === i) : l) },
  id: { min: 0, run: (_a, env) => env.id ?? '' },
};
const ALIASES: Record<string, string> = { tonumber: 'tonumber', avg: 'mean', moyenne: 'mean', somme: 'sum', si: 'if', vide: 'empty', longueur: 'length', contient: 'contains', maintenant: 'now', aujourdhui: 'today' };

function evalCall(n: Extract<Node, { k: 'call' }>, env: FormulaEnv): FValue {
  const raw = n.name.toLowerCase();
  const name = ALIASES[raw] ?? raw;
  const ev = (x: Node) => evaluate(x, env);
  switch (name) {
    case 'prop': {
      arity('prop', n.args, 1);
      const a = n.args[0];
      if (a.k !== 'str') throw new FormulaError('prop() attend le nom d’une propriété entre guillemets, ex. prop("Prix")', n.p);
      return env.prop(a.v);
    }
    case 'if': {
      arity('if', n.args, 3);
      return toBool(ev(n.args[0])) ? ev(n.args[1]) : ev(n.args[2]);
    }
    case 'ifs': {
      if (n.args.length < 2) arity('ifs', n.args, 2, Infinity);
      for (let i = 0; i + 1 < n.args.length; i += 2) if (toBool(ev(n.args[i]))) return ev(n.args[i + 1]);
      return n.args.length % 2 ? ev(n.args[n.args.length - 1]) : null;
    }
    case 'and': { arity('and', n.args, 1, Infinity); for (const a of n.args) if (!toBool(ev(a))) return false; return true; }
    case 'or': { arity('or', n.args, 1, Infinity); for (const a of n.args) if (toBool(ev(a))) return true; return false; }
  }
  const fn = F[name];
  if (!fn) throw new FormulaError(`Fonction inconnue : « ${n.name}() »`, n.p);
  arity(n.name, n.args, fn.min, fn.max ?? fn.min);
  return fn.run(n.args.map(ev), env);
}

export function evaluate(n: Node, env: FormulaEnv): FValue {
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'list': return n.items.map(i => evaluate(i, env));
    case 'tern': return toBool(evaluate(n.c, env)) ? evaluate(n.a, env) : evaluate(n.b, env);
    case 'call': return evalCall(n, env);
    case 'un': {
      const a = evaluate(n.a, env);
      if (n.op === 'not') return !toBool(a);
      if (a === null) return null;
      const v = toNum(a, `L’opérateur « ${n.op} »`);
      return n.op === '-' ? -v : v;
    }
    case 'bin': {
      if (n.op === 'and') return toBool(evaluate(n.a, env)) && toBool(evaluate(n.b, env));
      if (n.op === 'or') return toBool(evaluate(n.a, env)) || toBool(evaluate(n.b, env));
      const a = evaluate(n.a, env), b = evaluate(n.b, env);
      switch (n.op) {
        case '==': return equals(a, b);
        case '!=': return !equals(a, b);
        case '<': case '>': case '<=': case '>=': return compare(a, b, n.op);
        case '+': {
          if (a instanceof Date || b instanceof Date) throw new FormulaError('Impossible d’additionner une date : utilise dateAdd(date, nombre, "days")', n.p);
          if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
          if (typeof a === 'string' || typeof b === 'string' || Array.isArray(a) || Array.isArray(b)) return fToString(a) + fToString(b);
          if (a === null && b === null) return null;
          return toNum(a, 'L’opérateur « + »') + toNum(b, 'L’opérateur « + »');
        }
        case '-': {
          if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
          if (a instanceof Date || b instanceof Date) throw new FormulaError('Impossible de soustraire à une date : utilise dateSubtract(date, nombre, "days")', n.p);
          if (a === null && b === null) return null;
          return toNum(a, 'L’opérateur « - »') - toNum(b, 'L’opérateur « - »');
        }
        case '*': return toNum(a, 'L’opérateur « * »') * toNum(b, 'L’opérateur « * »');
        case '/': { const d = toNum(b, 'L’opérateur « / »'); if (d === 0) throw new FormulaError('Division par zéro', n.p); return toNum(a, 'L’opérateur « / »') / d; }
        case '%': { const d = toNum(b, 'L’opérateur « % »'); if (d === 0) throw new FormulaError('Division par zéro (modulo)', n.p); return toNum(a, 'L’opérateur « % »') % d; }
        case '^': return toNum(a, 'L’opérateur « ^ »') ** toNum(b, 'L’opérateur « ^ »');
      }
    }
  }
  throw new FormulaError('Expression invalide');
}

/** Évalue une formule ; renvoie la valeur ou l'erreur lisible. */
export function runFormula(src: string, env: FormulaEnv): { value: FValue; error?: undefined } | { value?: undefined; error: string } {
  try { return { value: evaluate(compile(src), env) }; }
  catch (e) { return { error: e instanceof FormulaError ? e.message : `Erreur : ${(e as Error).message}` }; }
}

/** Noms des propriétés référencées par prop("…"). */
export function referencedProps(src: string): string[] {
  const out: string[] = [];
  try {
    const walk = (n: Node) => {
      if (n.k === 'call') { if (n.name.toLowerCase() === 'prop' && n.args[0]?.k === 'str') out.push(n.args[0].v); n.args.forEach(walk); }
      else if (n.k === 'bin') { walk(n.a); walk(n.b); }
      else if (n.k === 'un') walk(n.a);
      else if (n.k === 'tern') { walk(n.c); walk(n.a); walk(n.b); }
      else if (n.k === 'list') n.items.forEach(walk);
    };
    walk(compile(src));
  } catch { /* formule invalide : pas de références */ }
  return out;
}

/** Met à jour prop("Ancien") → prop("Nouveau") dans une formule (renommage de propriété). */
export function renamePropInFormula(src: string, oldName: string, newName: string): string {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const safe = newName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return src.replace(new RegExp(`prop\\(\\s*(["'“«])\\s*${esc}\\s*(["'”»])\\s*\\)`, 'g'), `prop("${safe}")`);
}

/** Aide affichée dans l'éditeur de formule. */
export const FORMULA_HELP: { name: string; syntax: string; description: string; group: string }[] = [
  { group: 'Propriétés', name: 'prop', syntax: 'prop("Nom")', description: 'Valeur d’une propriété de la ligne' },
  { group: 'Logique', name: 'if', syntax: 'if(condition, siVrai, siFaux)', description: 'Condition' },
  { group: 'Logique', name: 'ifs', syntax: 'ifs(c1, v1, c2, v2, sinon)', description: 'Conditions en cascade' },
  { group: 'Logique', name: 'and', syntax: 'a and b', description: 'Et logique (aussi &&)' },
  { group: 'Logique', name: 'or', syntax: 'a or b', description: 'Ou logique (aussi ||)' },
  { group: 'Logique', name: 'not', syntax: 'not a', description: 'Négation (aussi !)' },
  { group: 'Logique', name: 'empty', syntax: 'empty(valeur)', description: 'Vrai si la valeur est vide' },
  { group: 'Texte', name: 'concat', syntax: 'concat(a, b, …)', description: 'Assemble des textes (ou des listes)' },
  { group: 'Texte', name: 'length', syntax: 'length(texte)', description: 'Longueur d’un texte ou d’une liste' },
  { group: 'Texte', name: 'contains', syntax: 'contains(texte, "x")', description: 'Contient le texte / l’élément' },
  { group: 'Texte', name: 'replace', syntax: 'replace(texte, "motif", "par")', description: 'Remplace la 1re occurrence (regex)' },
  { group: 'Texte', name: 'replaceAll', syntax: 'replaceAll(texte, "motif", "par")', description: 'Remplace toutes les occurrences' },
  { group: 'Texte', name: 'lower', syntax: 'lower(texte)', description: 'Minuscules' },
  { group: 'Texte', name: 'upper', syntax: 'upper(texte)', description: 'Majuscules' },
  { group: 'Texte', name: 'format', syntax: 'format(valeur)', description: 'Convertit en texte' },
  { group: 'Texte', name: 'join', syntax: 'join(liste, ", ")', description: 'Assemble une liste' },
  { group: 'Nombres', name: 'round', syntax: 'round(n, décimales?)', description: 'Arrondi' },
  { group: 'Nombres', name: 'floor', syntax: 'floor(n)', description: 'Arrondi inférieur' },
  { group: 'Nombres', name: 'ceil', syntax: 'ceil(n)', description: 'Arrondi supérieur' },
  { group: 'Nombres', name: 'abs', syntax: 'abs(n)', description: 'Valeur absolue' },
  { group: 'Nombres', name: 'min', syntax: 'min(a, b, …)', description: 'Minimum' },
  { group: 'Nombres', name: 'max', syntax: 'max(a, b, …)', description: 'Maximum' },
  { group: 'Nombres', name: 'sum', syntax: 'sum(a, b, …)', description: 'Somme' },
  { group: 'Nombres', name: 'toNumber', syntax: 'toNumber(valeur)', description: 'Convertit en nombre' },
  { group: 'Dates', name: 'now', syntax: 'now()', description: 'Date et heure actuelles' },
  { group: 'Dates', name: 'today', syntax: 'today()', description: 'Aujourd’hui (minuit)' },
  { group: 'Dates', name: 'dateAdd', syntax: 'dateAdd(date, 3, "days")', description: 'Ajoute une durée' },
  { group: 'Dates', name: 'dateSubtract', syntax: 'dateSubtract(date, 1, "months")', description: 'Retire une durée' },
  { group: 'Dates', name: 'dateBetween', syntax: 'dateBetween(date1, date2, "days")', description: 'Écart entre deux dates' },
  { group: 'Dates', name: 'formatDate', syntax: 'formatDate(date, "DD/MM/YYYY")', description: 'Formate une date' },
  { group: 'Dates', name: 'year', syntax: 'year(date)', description: 'Année (aussi month, day, hour…)' },
  { group: 'Dates', name: 'end', syntax: 'end(date)', description: 'Fin d’une plage de dates' },
];
