// Types de fichiers : détection (extension + MIME), libellés, couleurs, icônes SVG, formats d'affichage.
// Module pur (aucune dépendance au DOM ni à Tauri) → testé dans __tests__/kinds.test.ts.

export type FileKind =
  | 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'text' | 'design' | 'archive'
  | 'document' | 'spreadsheet' | 'presentation' | 'font' | 'model' | 'other';

const groups: Record<Exclude<FileKind, 'other'>, string> = {
  image: 'png jpg jpeg jfif gif webp avif bmp svg ico cur tif tiff heic heif',
  video: 'mp4 m4v mov mkv webm avi wmv flv mpg mpeg m2ts 3gp ogv',
  audio: 'mp3 wav flac aac ogg oga opus m4a wma aif aiff mid midi',
  pdf: 'pdf',
  code: 'lua luau js mjs cjs jsx ts tsx py pyw rb php java kt kts c h cc cpp cxx hpp hh cs go rs swift dart sh bash zsh bat cmd ps1 psm1 json jsonc yaml yml toml xml html htm css scss sass less sql ini cfg conf glsl hlsl shader vue svelte gd r pl vb vbs asm gradle properties graphql gql diff patch makefile rbxlx rbxmx',
  text: 'txt md markdown csv tsv log srt vtt ass nfo',
  design: 'psd psb ai eps indd xd fig sketch afdesign afphoto afpub kra xcf clip procreate aep aet prproj drp veg kdenlive',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst iso dmg cab',
  document: 'doc docx odt rtf pages epub',
  spreadsheet: 'xls xlsx xlsm ods numbers',
  presentation: 'ppt pptx odp key',
  font: 'ttf otf woff woff2',
  model: 'blend fbx obj stl glb gltf dae 3ds c4d ma mb usdz rbxm rbxl',
};
const BY_EXT: Record<string, FileKind> = {};
for (const [kind, exts] of Object.entries(groups)) for (const e of exts.split(' ')) BY_EXT[e] = kind as FileKind;

/** Extension en minuscules, sans le point ('' si aucune). « .gitignore » → ''. */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** Dernier segment d'un chemin Windows ou POSIX. */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Type d'un fichier d'après son extension, puis son MIME. */
export function fileKind(name: string, mime = ''): FileKind {
  const byExt = BY_EXT[extOf(name)];
  if (byExt) return byExt;
  const m = mime.toLowerCase().split(';')[0].trim();
  if (m === 'image/vnd.adobe.photoshop' || m === 'application/postscript') return 'design';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('font/')) return 'font';
  if (m.startsWith('model/')) return 'model';
  if (/^(text\/x-|application\/(json|javascript|x-javascript|xml|x-sh|x-python|typescript|sql|toml|yaml|x-yaml))/.test(m)) return 'code';
  if (m.startsWith('text/')) return 'text';
  if (/(zip|x-7z|x-rar|vnd\.rar|gzip|x-tar|x-bzip|x-xz|zstd)/.test(m)) return 'archive';
  if (/(msword|wordprocessingml|opendocument\.text|rtf)/.test(m)) return 'document';
  if (/(ms-excel|spreadsheetml|opendocument\.spreadsheet)/.test(m)) return 'spreadsheet';
  if (/(ms-powerpoint|presentationml|opendocument\.presentation)/.test(m)) return 'presentation';
  return 'other';
}

export interface KindMeta { label: string; color: string }
export const KIND_META: Record<FileKind, KindMeta> = {
  image: { label: 'Image', color: '#30b158' },
  video: { label: 'Vidéo', color: '#8e5cf7' },
  audio: { label: 'Audio', color: '#ff375f' },
  pdf: { label: 'PDF', color: '#e5484d' },
  code: { label: 'Code', color: '#5e5ce6' },
  text: { label: 'Texte', color: '#8e8e93' },
  design: { label: 'Création', color: '#31a8ff' },
  archive: { label: 'Archive', color: '#b07d48' },
  document: { label: 'Document', color: '#2b7cd3' },
  spreadsheet: { label: 'Tableur', color: '#1f9d55' },
  presentation: { label: 'Présentation', color: '#f2711c' },
  font: { label: 'Police', color: '#6e6e73' },
  model: { label: 'Modèle 3D', color: '#ff9f0a' },
  other: { label: 'Fichier', color: '#8e8e93' },
};

/** Libellé précis (« Script Lua », « Photoshop »…) pour l'aperçu. */
export function kindLabel(name: string, mime = ''): string {
  const ext = extOf(name);
  const special: Record<string, string> = {
    psd: 'Photoshop', psb: 'Photoshop (grand format)', ai: 'Illustrator', aep: 'After Effects', prproj: 'Premiere Pro',
    drp: 'DaVinci Resolve', blend: 'Blender', fig: 'Figma', xd: 'Adobe XD', kra: 'Krita', clip: 'Clip Studio',
    rbxl: 'Place Roblox', rbxm: 'Modèle Roblox', rbxlx: 'Place Roblox (XML)', rbxmx: 'Modèle Roblox (XML)',
    srt: 'Sous-titres', vtt: 'Sous-titres', md: 'Markdown', csv: 'CSV', svg: 'Image vectorielle', gif: 'GIF animé',
  };
  if (special[ext]) return special[ext];
  const lang = languageOf(name);
  if (fileKind(name, mime) === 'code' && lang.label) return `Code ${lang.label}`;
  const base = KIND_META[fileKind(name, mime)].label;
  return ext ? `${base} ${ext.toUpperCase()}` : base;
}

/** Langage pour la coloration (identifiants lowlight « common »). */
export function languageOf(name: string): { id: string; label: string } {
  const ext = extOf(name);
  const map: Record<string, [string, string]> = {
    lua: ['lua', 'Lua'], luau: ['lua', 'Luau'], js: ['javascript', 'JavaScript'], mjs: ['javascript', 'JavaScript'], cjs: ['javascript', 'JavaScript'],
    jsx: ['javascript', 'JSX'], ts: ['typescript', 'TypeScript'], tsx: ['typescript', 'TSX'], py: ['python', 'Python'], pyw: ['python', 'Python'],
    rb: ['ruby', 'Ruby'], php: ['php', 'PHP'], java: ['java', 'Java'], kt: ['kotlin', 'Kotlin'], kts: ['kotlin', 'Kotlin'], c: ['c', 'C'], h: ['c', 'C'],
    cc: ['cpp', 'C++'], cpp: ['cpp', 'C++'], cxx: ['cpp', 'C++'], hpp: ['cpp', 'C++'], hh: ['cpp', 'C++'], cs: ['csharp', 'C#'], go: ['go', 'Go'],
    rs: ['rust', 'Rust'], swift: ['swift', 'Swift'], sh: ['bash', 'Shell'], bash: ['bash', 'Bash'], zsh: ['bash', 'Zsh'], json: ['json', 'JSON'],
    jsonc: ['json', 'JSON'], yaml: ['yaml', 'YAML'], yml: ['yaml', 'YAML'], toml: ['ini', 'TOML'], ini: ['ini', 'INI'], cfg: ['ini', 'Config'],
    conf: ['ini', 'Config'], properties: ['ini', 'Properties'], xml: ['xml', 'XML'], html: ['xml', 'HTML'], htm: ['xml', 'HTML'], svg: ['xml', 'SVG'],
    vue: ['xml', 'Vue'], svelte: ['xml', 'Svelte'], rbxlx: ['xml', 'Roblox XML'], rbxmx: ['xml', 'Roblox XML'], css: ['css', 'CSS'], scss: ['scss', 'SCSS'],
    less: ['less', 'Less'], sql: ['sql', 'SQL'], md: ['markdown', 'Markdown'], markdown: ['markdown', 'Markdown'], r: ['r', 'R'], pl: ['perl', 'Perl'],
    vb: ['vbnet', 'VB.NET'], graphql: ['graphql', 'GraphQL'], gql: ['graphql', 'GraphQL'], diff: ['diff', 'Diff'], patch: ['diff', 'Diff'],
    makefile: ['makefile', 'Makefile'], gradle: ['kotlin', 'Gradle'], glsl: ['c', 'GLSL'], hlsl: ['c', 'HLSL'], shader: ['c', 'Shader'],
    gd: ['python', 'GDScript'], bat: ['plaintext', 'Batch'], cmd: ['plaintext', 'Batch'], ps1: ['plaintext', 'PowerShell'], psm1: ['plaintext', 'PowerShell'],
    vbs: ['vbnet', 'VBScript'], asm: ['plaintext', 'Assembleur'],
  };
  const hit = map[ext];
  return hit ? { id: hit[0], label: hit[1] } : { id: 'plaintext', label: '' };
}

/** Le contenu peut-il être lu comme du texte (extrait de code) ? */
export const isTextual = (kind: FileKind) => kind === 'code' || kind === 'text';

/** MIME probable d'après le nom (mode navigateur, quand File.type est vide). */
export function guessMime(name: string): string {
  const ext = extOf(name);
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4',
    pdf: 'application/pdf', json: 'application/json', js: 'text/javascript', ts: 'text/x-typescript', lua: 'text/x-lua', py: 'text/x-python',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', css: 'text/css', xml: 'application/xml', srt: 'application/x-subrip',
    zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', psd: 'image/vnd.adobe.photoshop',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2',
  };
  return table[ext] ?? 'application/octet-stream';
}

// ───────────── Groupes de filtres (vue Fichiers) ─────────────
export type KindGroup = 'all' | 'image' | 'video' | 'audio' | 'pdf' | 'code' | 'design' | 'archive' | 'document' | 'other';
export const KIND_GROUPS: { id: KindGroup; label: string; kinds: FileKind[] }[] = [
  { id: 'all', label: 'Tous', kinds: [] },
  { id: 'image', label: 'Images', kinds: ['image'] },
  { id: 'video', label: 'Vidéos', kinds: ['video'] },
  { id: 'audio', label: 'Audio', kinds: ['audio'] },
  { id: 'pdf', label: 'PDF', kinds: ['pdf'] },
  { id: 'code', label: 'Code', kinds: ['code'] },
  { id: 'design', label: 'Création', kinds: ['design', 'model', 'font'] },
  { id: 'archive', label: 'Archives', kinds: ['archive'] },
  { id: 'document', label: 'Documents', kinds: ['document', 'spreadsheet', 'presentation', 'text'] },
  { id: 'other', label: 'Autres', kinds: ['other'] },
];
export const groupOf = (kind: FileKind): KindGroup => KIND_GROUPS.find(g => g.kinds.includes(kind))?.id ?? 'other';

// ───────────── Icônes (SVG 24×24, trait façon SF Symbols) ─────────────
const DOC = '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/>';
const GLYPHS: Record<FileKind, string> = {
  image: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5.5 19.8"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M10 9.2v5.6a.6.6 0 0 0 .9.5l4.6-2.8a.6.6 0 0 0 0-1l-4.6-2.8a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>',
  audio: '<path d="M9 17.5V5.8a1 1 0 0 1 .8-1l9-1.7a1 1 0 0 1 1.2 1v11.4"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>',
  pdf: DOC + '<path d="M8.5 13h7M8.5 16.5h4.5"/>',
  code: '<path d="m8 7.5-4.5 4.5L8 16.5M16 7.5l4.5 4.5-4.5 4.5M13.6 4.5l-3.2 15"/>',
  text: DOC + '<path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4"/>',
  design: '<path d="m12 3.5 8.5 4.6-8.5 4.6-8.5-4.6z"/><path d="m3.5 12.3 8.5 4.6 8.5-4.6"/><path d="m3.5 16.2 8.5 4.6 8.5-4.6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.6"/><path d="M5 9v9a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V9"/><path d="M10 13h4"/>',
  document: DOC + '<path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4"/>',
  spreadsheet: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9.5h18M3 14.5h18M9.5 4v16"/>',
  presentation: '<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M12 16v4.5M8 20.5h8M8.5 12V9.5M12 12V8M15.5 12v-1.5"/>',
  font: '<path d="m5 20 6-16h2l6 16"/><path d="M7.4 14h9.2"/>',
  model: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  other: DOC,
};

/** Icône SVG (chaîne statique, sûre pour innerHTML) teintée par `currentColor`. */
export function iconSvg(kind: FileKind, size = 16, strokeWidth = 1.8): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[kind]}</svg>`;
}
export const LINK_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1"/></svg>';
export const WARN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/></svg>';

// ───────────── Formats ─────────────
/** Tronque au milieu en gardant l'extension : « Rapport annuel 2025 fin….pdf ». */
export function truncateMiddle(name: string, max = 28): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const ext = extOf(name);
  const tail = ext && ext.length <= 8 ? '.' + ext : '';
  const keep = Math.max(1, max - Array.from(tail).length - 1);
  return chars.slice(0, keep).join('').trimEnd() + '…' + tail;
}

const nf = (digits: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits });
/** Taille lisible (base 1024, unités françaises comme l'explorateur Windows). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = bytes / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${nf(v < 10 ? 1 : 0).format(v)} ${units[i]}`;
}
export function formatDate(ms: number | undefined): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
/** « 3 fichiers », « 1 fichier ». */
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n > 1 ? many : one}`;
