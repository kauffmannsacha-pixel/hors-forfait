// Palette Notion-like (texte, fonds, callouts). Les valeurs sont des variables CSS → s'adaptent au thème.
export interface ColorDef { id: string; label: string; text: string | null; bg: string | null; swatch: string }

export const COLORS: ColorDef[] = [
  { id: 'default', label: 'Par défaut', text: null, bg: null, swatch: 'var(--fg)' },
  { id: 'gray', label: 'Gris', text: 'var(--tc-gray)', bg: 'var(--bc-gray)', swatch: '#8e8e93' },
  { id: 'brown', label: 'Marron', text: 'var(--tc-brown)', bg: 'var(--bc-brown)', swatch: '#a2845e' },
  { id: 'orange', label: 'Orange', text: 'var(--tc-orange)', bg: 'var(--bc-orange)', swatch: '#ff9f0a' },
  { id: 'yellow', label: 'Jaune', text: 'var(--tc-yellow)', bg: 'var(--bc-yellow)', swatch: '#ffd60a' },
  { id: 'green', label: 'Vert', text: 'var(--tc-green)', bg: 'var(--bc-green)', swatch: '#30d158' },
  { id: 'blue', label: 'Bleu', text: 'var(--tc-blue)', bg: 'var(--bc-blue)', swatch: '#0a84ff' },
  { id: 'purple', label: 'Violet', text: 'var(--tc-purple)', bg: 'var(--bc-purple)', swatch: '#bf5af2' },
  { id: 'pink', label: 'Rose', text: 'var(--tc-pink)', bg: 'var(--bc-pink)', swatch: '#ff375f' },
  { id: 'red', label: 'Rouge', text: 'var(--tc-red)', bg: 'var(--bc-red)', swatch: '#ff453a' },
];
export const colorById = (id: string | null | undefined) => COLORS.find(c => c.id === id) ?? COLORS[0];

/** Couleurs concrètes (export HTML autonome). */
export const EXPORT_COLOR_VARS = `
  --tc-gray:#787774;--tc-brown:#9f6b53;--tc-orange:#d9730d;--tc-yellow:#cb912f;--tc-green:#448361;--tc-blue:#337ea9;--tc-purple:#9065b0;--tc-pink:#c14c8a;--tc-red:#d44c47;
  --bc-gray:#f1f1ef;--bc-brown:#f4eeee;--bc-orange:#fbecdd;--bc-yellow:#fbf3db;--bc-green:#edf3ec;--bc-blue:#e7f3f8;--bc-purple:#f6f3f9;--bc-pink:#faf1f5;--bc-red:#fdebec;`;
