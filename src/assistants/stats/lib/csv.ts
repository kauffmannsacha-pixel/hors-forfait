// Export / import CSV (RFC 4180). Par défaut au format Excel français : séparateur « ; »,
// virgule décimale, BOM UTF-8 et fins de ligne CRLF.
export type CsvValue = string | number | boolean | Date | null | undefined;
export interface CsvOptions {
  sep?: string;
  decimal?: '.' | ',';
  bom?: boolean;
  newline?: string;
  /** Neutralise les cellules texte commençant par = + - @ (injection de formules dans Excel). */
  guardFormulas?: boolean;
}
export interface CsvTable { filename: string; header: string[]; rows: CsvValue[][] }

const DEFAULTS: Required<CsvOptions> = { sep: ';', decimal: ',', bom: true, newline: '\r\n', guardFormulas: true };

export function csvCell(v: CsvValue, o: CsvOptions = {}): string {
  const opt = { ...DEFAULTS, ...o };
  if (v == null) return '';
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    // 6 décimales max : supprime le bruit binaire (0,1 + 0,2) sans perdre de précision utile.
    const r = Math.round(v * 1e6) / 1e6;
    s = String(Object.is(r, -0) ? 0 : r);
    if (opt.decimal === ',') s = s.replace('.', ',');
  } else if (typeof v === 'boolean') {
    s = v ? 'oui' : 'non';
  } else if (v instanceof Date) {
    s = Number.isNaN(v.getTime()) ? '' : v.toISOString();
  } else {
    s = v;
    if (opt.guardFormulas && /^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  }
  const mustQuote = s.includes(opt.sep) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s);
  return mustQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(header: string[], rows: CsvValue[][], o: CsvOptions = {}): string {
  const opt = { ...DEFAULTS, ...o };
  const lines = [header, ...rows].map(r => r.map(c => csvCell(c, opt)).join(opt.sep));
  return (opt.bom ? '\uFEFF' : '') + lines.join(opt.newline) + opt.newline;
}

/** Analyse un CSV (guillemets, guillemets doublés, retours à la ligne dans une cellule, BOM). */
export function parseCSV(text: string, sep = ','): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; continue; }
    if (c === sep) { row.push(cell); cell = ''; continue; }
    if (c === '\r' && src[i + 1] === '\n') continue;
    if (c === '\n' || c === '\r') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Nom de fichier sûr : « Rétention — Ma vidéo » → « retention-ma-video ». */
export function safeFilename(s: string, max = 60): string {
  const base = s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return base || 'export';
}
