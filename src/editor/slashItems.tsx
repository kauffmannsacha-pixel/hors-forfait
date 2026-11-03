// Éléments intégrés du menu « / » (les autres modules ajoutent les leurs via registerSlashItem).
import type { Editor, Range } from '@tiptap/core';
import type { SlashItem } from '../ui/registry';
import { slashItems as registrySlashItems } from '../ui/registry';
import { createPage } from '../db/pages';
import { currentPageId, openPage, toast } from '../ui/appState';
import { caretAnchor, pickDate, pickMedia, promptText } from './ui/overlays';
import { toEmbedUrl } from './nodes/embed';
import { fuzzyBest } from './fuzzy';
import { insertDateMention, insertReminderMention } from './nodes/mention';
import { openTemplateGallery } from './templateStore';
import type { MediaKind } from './media';

const GROUP_ORDER = ['Blocs de base', 'Médias', 'Avancé', 'Mentions', 'Intégrations', 'Modèles'];

const del = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

export async function insertMediaBlock(editor: Editor, kind: MediaKind | 'embed') {
  const r = await pickMedia(caretAnchor(editor.view), kind);
  if (!r) { editor.commands.focus(); return; }
  const chain = editor.chain().focus();
  const embeddable = /^https?:/i.test(r.src) ? toEmbedUrl(r.src) : null;
  if (kind === 'embed' || (kind === 'video' && embeddable && embeddable.provider !== 'web')) { chain.setEmbed(r.src).run(); return; }
  if (kind === 'image') chain.insertContent({ type: 'image', attrs: { src: r.src, alt: r.name, title: r.name, hash: r.hash ?? null } }).run();
  else chain.insertContent({ type: kind === 'file' ? 'fileBlock' : kind, attrs: { src: r.src, hash: r.hash ?? null, name: r.name, mime: r.mime, size: r.size ?? null } }).run();
}

async function insertMath(editor: Editor, block: boolean) {
  const latex = await promptText(caretAnchor(editor.view), {
    title: block ? 'Équation (LaTeX)' : 'Équation en ligne (LaTeX)', placeholder: block ? '\\int_0^1 x^2\\,dx = \\frac{1}{3}' : 'E = mc^2',
    multiline: block, preview: block ? 'math-block' : 'math-inline', confirmLabel: 'Insérer',
  });
  if (!latex?.trim()) { editor.commands.focus(); return; }
  if (block) editor.chain().focus().insertBlockMath({ latex }).run();
  else editor.chain().focus().insertInlineMath({ latex }).run();
}

export const BUILTIN_SLASH_ITEMS: SlashItem[] = [
  { id: 'text', title: 'Texte', description: 'Commence à écrire en texte simple.', icon: 'Aa', group: 'Blocs de base', keywords: ['paragraphe', 'texte', 'normal'], run: ({ editor, range }) => { del(editor, range).setParagraph().run(); } },
  { id: 'h1', title: 'Titre 1', description: 'Grand titre de section.', icon: 'H1', group: 'Blocs de base', keywords: ['h1', 'titre', 'heading', '#'], run: ({ editor, range }) => { del(editor, range).setHeading({ level: 1 }).run(); } },
  { id: 'h2', title: 'Titre 2', description: 'Titre de section moyen.', icon: 'H2', group: 'Blocs de base', keywords: ['h2', 'titre', 'sous-titre', '##'], run: ({ editor, range }) => { del(editor, range).setHeading({ level: 2 }).run(); } },
  { id: 'h3', title: 'Titre 3', description: 'Petit titre de section.', icon: 'H3', group: 'Blocs de base', keywords: ['h3', 'titre', '###'], run: ({ editor, range }) => { del(editor, range).setHeading({ level: 3 }).run(); } },
  { id: 'bullet', title: 'Liste à puces', description: 'Une liste simple à puces.', icon: '•', group: 'Blocs de base', keywords: ['liste', 'puces', 'ul', '-'], run: ({ editor, range }) => { del(editor, range).toggleBulletList().run(); } },
  { id: 'numbered', title: 'Liste numérotée', description: 'Une liste numérotée.', icon: '1.', group: 'Blocs de base', keywords: ['liste', 'numéros', 'ol', '1.'], run: ({ editor, range }) => { del(editor, range).toggleOrderedList().run(); } },
  { id: 'todo', title: 'Liste de tâches', description: 'Suis tes tâches avec des cases à cocher.', icon: '☑', group: 'Blocs de base', keywords: ['todo', 'tâche', 'case', 'checkbox', '[]'], run: ({ editor, range }) => { del(editor, range).toggleTaskList().run(); } },
  { id: 'toggle', title: 'Toggle', description: 'Contenu repliable.', icon: '▸', group: 'Blocs de base', keywords: ['bascule', 'replier', 'déplier', 'details', '>>'], run: ({ editor, range }) => { del(editor, range).setDetails().run(); } },
  { id: 'quote', title: 'Citation', description: 'Pour citer quelqu’un.', icon: '❝', group: 'Blocs de base', keywords: ['citation', 'quote', 'blockquote', '>'], run: ({ editor, range }) => { del(editor, range).toggleBlockquote().run(); } },
  { id: 'callout', title: 'Callout', description: 'Fais ressortir une information.', icon: '💡', group: 'Blocs de base', keywords: ['encadré', 'note', 'astuce', 'alerte', '>!'], run: ({ editor, range }) => { del(editor, range).setCallout().run(); } },
  { id: 'divider', title: 'Séparateur', description: 'Sépare visuellement les blocs.', icon: '—', group: 'Blocs de base', keywords: ['ligne', 'hr', 'séparateur', '---'], run: ({ editor, range }) => { del(editor, range).setHorizontalRule().run(); } },
  { id: 'page', title: 'Page', description: 'Crée une sous-page dans cette page.', icon: '📄', group: 'Blocs de base', keywords: ['sous-page', 'page', 'nouvelle'], run: async ({ editor, range }) => {
    const parentId = currentPageId();
    const p = await createPage({ parentId, title: '' });
    del(editor, range).insertContent({ type: 'pageBlock', attrs: { pageId: p.id, title: '' } }).run();
    setTimeout(() => openPage(p.id), 60);
  } },
  { id: 'image', title: 'Image', description: 'Importe une image ou colle un lien.', icon: '🖼️', group: 'Médias', keywords: ['image', 'photo', 'png', 'jpg'], run: ({ editor, range }) => { del(editor, range).run(); void insertMediaBlock(editor, 'image'); } },
  { id: 'video', title: 'Vidéo', description: 'Importe une vidéo ou intègre YouTube / Vimeo.', icon: '🎬', group: 'Médias', keywords: ['vidéo', 'mp4', 'film'], run: ({ editor, range }) => { del(editor, range).run(); void insertMediaBlock(editor, 'video'); } },
  { id: 'audio', title: 'Audio', description: 'Importe un fichier audio.', icon: '🎵', group: 'Médias', keywords: ['audio', 'son', 'mp3', 'musique'], run: ({ editor, range }) => { del(editor, range).run(); void insertMediaBlock(editor, 'audio'); } },
  { id: 'file', title: 'Fichier', description: 'Joins un fichier à la page.', icon: '📎', group: 'Médias', keywords: ['fichier', 'pièce jointe', 'pdf', 'document'], run: ({ editor, range }) => { del(editor, range).run(); void insertMediaBlock(editor, 'file'); } },
  { id: 'embed', title: 'Intégration', description: 'Intègre un site (Figma, Loom, Maps, Spotify…).', icon: '⧉', group: 'Médias', keywords: ['embed', 'iframe', 'intégrer', 'figma', 'loom', 'spotify', 'maps'], run: ({ editor, range }) => { del(editor, range).run(); void insertMediaBlock(editor, 'embed'); } },
  { id: 'youtube', title: 'YouTube', description: 'Intègre une vidéo YouTube.', icon: '▶️', group: 'Médias', keywords: ['youtube', 'vidéo', 'yt'], run: async ({ editor, range }) => {
    del(editor, range).run();
    const url = await promptText(caretAnchor(editor.view), { title: 'Lien de la vidéo YouTube', placeholder: 'https://www.youtube.com/watch?v=…', confirmLabel: 'Intégrer',
      validate: v => (toEmbedUrl(v)?.provider === 'youtube' ? null : 'Ce lien ne ressemble pas à une vidéo YouTube.') });
    if (url) editor.chain().focus().setEmbed(url).run(); else editor.commands.focus();
  } },
  { id: 'table', title: 'Tableau', description: 'Un tableau simple.', icon: '▦', group: 'Avancé', keywords: ['tableau', 'table', 'grille'], run: ({ editor, range }) => { del(editor, range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
  { id: 'columns2', title: '2 colonnes', description: 'Deux colonnes côte à côte.', icon: '◫', group: 'Avancé', keywords: ['colonnes', 'columns', 'côte à côte'], run: ({ editor, range }) => { del(editor, range).insertColumns(2).run(); } },
  { id: 'columns3', title: '3 colonnes', description: 'Trois colonnes côte à côte.', icon: '▥', group: 'Avancé', keywords: ['colonnes', 'columns'], run: ({ editor, range }) => { del(editor, range).insertColumns(3).run(); } },
  { id: 'code', title: 'Code', description: 'Bloc de code avec coloration.', icon: '</>', group: 'Avancé', keywords: ['code', 'programme', 'snippet', 'lua', '```'], run: ({ editor, range }) => { del(editor, range).setCodeBlock().run(); } },
  { id: 'math', title: 'Équation', description: 'Équation LaTeX (bloc).', icon: '∑', group: 'Avancé', keywords: ['équation', 'math', 'latex', 'formule', 'katex'], run: ({ editor, range }) => { del(editor, range).run(); void insertMath(editor, true); } },
  { id: 'math-inline', title: 'Équation en ligne', description: 'Formule LaTeX dans le texte.', icon: '√x', group: 'Avancé', keywords: ['équation', 'math', 'latex', 'inline'], run: ({ editor, range }) => { del(editor, range).run(); void insertMath(editor, false); } },
  { id: 'mention-page', title: 'Lien vers une page', description: 'Mentionne une page existante.', icon: '↗', group: 'Mentions', keywords: ['mention', 'lien', 'page', '@'], run: ({ editor, range }) => { del(editor, range).insertContent(' @').run(); } },
  { id: 'date', title: 'Date', description: 'Insère une date (@aujourd’hui, @demain…).', icon: '📅', group: 'Mentions', keywords: ['date', 'jour', 'calendrier', 'aujourd’hui'], run: async ({ editor, range }) => {
    del(editor, range).run();
    const at = editor.state.selection.from;
    const d = await pickDate(caretAnchor(editor.view), { withTime: false, title: 'Date' });
    if (d) insertDateMention(editor, at, d); else editor.commands.focus();
  } },
  { id: 'reminder', title: 'Rappel', description: 'Te notifie à la date et l’heure choisies.', icon: '⏰', group: 'Mentions', keywords: ['rappel', 'alarme', 'notification', 'remind'], run: async ({ editor, range }) => {
    del(editor, range).run();
    const at = editor.state.selection.from;
    const d = await pickDate(caretAnchor(editor.view), { withTime: true, reminder: true, title: 'Rappel' });
    if (d) await insertReminderMention(editor, at, d.getTime()); else editor.commands.focus();
  } },
  { id: 'template', title: 'Template', description: 'Insère un modèle (réunion, journal, brief vidéo…).', icon: '🧩', group: 'Modèles', keywords: ['template', 'modèle', 'gabarit'], run: ({ editor, range }) => { del(editor, range).run(); openTemplateGallery({ mode: 'insert', editor }); } },
];

const groupRank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length - 1 : i; };

/** Tous les éléments (intégrés + modules), groupés, filtrés par recherche floue. */
export function filterSlashItems(query: string): SlashItem[] {
  const ids = new Set(BUILTIN_SLASH_ITEMS.map(i => i.id));
  const all = [...BUILTIN_SLASH_ITEMS, ...registrySlashItems.filter(i => !ids.has(i.id))];
  if (!query.trim()) return [...all].sort((a, b) => groupRank(a.group) - groupRank(b.group));
  return all
    .map((it, i) => ({ it, i, s: fuzzyBest(query, [[it.title, 1.2], [(it.keywords ?? []).join(' '), 1], [it.description, 0.5], [it.group, 0.4]]) }))
    .filter((x): x is { it: SlashItem; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 30)
    .map(x => x.it);
}

/** Lance un élément « / » en gérant les erreurs (toast). */
export function runSlashItem(item: SlashItem, editor: Editor, range: Range) {
  try {
    const r = item.run({ editor, range }) as unknown;
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(e => toast((e as Error).message || 'Action impossible.', 'error'));
  } catch (e) { toast((e as Error).message || 'Action impossible.', 'error'); }
}
