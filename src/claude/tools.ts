// Outils internes de Prisme exposés à Claude (enregistrés dans registry.claudeTools).
// Les actions destructives sont marquées `destructive` : la boucle d'outils demande confirmation.
import type { Editor, JSONContent } from '@tiptap/core';
import { allPages, createPage, displayTitle, getPage, trashPage, updatePage } from '../db/pages';
import { repo, uid } from '../db/store';
import type { Page, PropertyDef } from '../db/types';
import { addRow, createDatabase, getSchema, rowsOf, saveSchema } from '../database/api';
import { getActiveEditor } from '../editor/active';
import { FILE_PIN_NODE, files } from '../files/api';
import { openPage } from '../ui/appState';
import type { ClaudeTool } from '../ui/registry';
import { normalizeProperties, normalizeRow } from './dbNormalize';
import { markdownToDoc, markdownToEditorHtml } from './markdown';
import { clipText, docToMarkdown, docToPlainText } from './pageText';

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function requirePage(id: unknown): Page {
  const p = getPage(str(id));
  if (!p) throw new Error(`Page introuvable (id « ${str(id)} »). Utilise search_pages pour trouver l'identifiant.`);
  return p;
}
const pageLabel = (p: Page) => `« ${displayTitle(p)} »`;

/** Éditeur ouvert sur cette page (pour que les modifications apparaissent en direct). */
function openEditorFor(pageId: string): Editor | null {
  const a = getActiveEditor();
  return a && a.pageId === pageId && !a.editor.isDestroyed ? a.editor : null;
}

const docContent = (doc: unknown): unknown[] => {
  const c = (doc as { content?: unknown[] } | null)?.content;
  return Array.isArray(c) ? c : [];
};
const isEmptyDoc = (doc: unknown) => {
  const c = docContent(doc);
  return !c.length || (c.length === 1 && (c[0] as { type?: string; content?: unknown[] }).type === 'paragraph' && !((c[0] as { content?: unknown[] }).content?.length));
};

// ───────────────────────────── Recherche (pur) ─────────────────────────────

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface PageHit { id: string; title: string; kind: string; parent: string | null; excerpt: string; updatedAt: string; score: number }

/** Recherche simple dans les titres et le texte des pages (repli sans FTS5). */
export function searchPagesLocal(pages: Page[], query: string, limit = 10): PageHit[] {
  const q = fold(query.trim());
  const terms = q.split(/\s+/).filter(Boolean);
  const byId = new Map(pages.map(p => [p.id, p]));
  const hits: PageHit[] = [];
  for (const p of pages) {
    if (p.trashed) continue;
    const title = fold(p.title || '');
    const text = docToPlainText(p.content);
    const body = fold(text);
    let score = 0;
    if (!terms.length) score = 1;
    else {
      for (const t of terms) {
        if (title.includes(t)) score += title.startsWith(t) ? 6 : 4;
        const n = body.split(t).length - 1;
        if (n) score += Math.min(5, n);
        else if (!title.includes(t)) { score = 0; break; }
      }
      if (score && title === q) score += 10;
    }
    if (!score) continue;
    const at = terms.length ? body.indexOf(terms[0]) : 0;
    const excerpt = text ? (at > 60 ? '…' : '') + text.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 220) + (text.length > at + 160 ? '…' : '') : '';
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    hits.push({ id: p.id, title: displayTitle(p), kind: p.kind, parent: parent ? displayTitle(parent) : null, excerpt, updatedAt: new Date(p.updatedAt).toISOString(), score });
  }
  hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  return hits.slice(0, limit);
}

// ───────────────────────────── Outils ─────────────────────────────

const mdHint = 'Markdown : titres #, listes -, cases à cocher - [ ], tableaux GFM, citations >, blocs de code ```.';

const createPageTool: ClaudeTool = {
  name: 'create_page',
  description: `Crée une nouvelle page Prisme (éventuellement sous une page parente) avec un contenu en Markdown. ${mdHint} Renvoie l'identifiant de la page.`,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Titre de la page' },
      content_markdown: { type: 'string', description: 'Contenu initial en Markdown (facultatif)' },
      parent_id: { type: 'string', description: 'Identifiant de la page parente (facultatif ; racine par défaut)' },
      icon: { type: 'string', description: 'Emoji d\'icône (facultatif)' },
      open: { type: 'boolean', description: 'Ouvrir la page après création (défaut : false)' },
    },
    required: ['title'],
  },
  run: async (input: Input) => {
    const parentId = str(input.parent_id) || null;
    if (parentId) requirePage(parentId);
    const page = await createPage({
      title: str(input.title).trim() || 'Sans titre',
      icon: str(input.icon) || undefined,
      parentId,
      content: markdownToDoc(str(input.content_markdown)),
    });
    if (input.open === true) openPage(page.id);
    return { ok: true, page_id: page.id, title: displayTitle(page), message: `Page ${pageLabel(page)} créée.` };
  },
};

const readPageTool: ClaudeTool = {
  name: 'read_page',
  description: 'Lit le contenu complet d\'une page Prisme (converti en Markdown). Utilise search_pages pour obtenir l\'identifiant.',
  input_schema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'Identifiant de la page' },
      max_chars: { type: 'integer', description: 'Nombre maximal de caractères renvoyés (défaut : 100000)' },
    },
    required: ['page_id'],
  },
  run: async (input: Input) => {
    const p = requirePage(input.page_id);
    const ed = openEditorFor(p.id);
    const md = docToMarkdown(ed ? ed.getJSON() : p.content);
    const clip = clipText(md, Math.max(1000, Number(input.max_chars) || 100_000));
    const children = allPages().filter(c => c.parentId === p.id && !c.trashed).map(c => ({ id: c.id, title: displayTitle(c), kind: c.kind }));
    return { page_id: p.id, title: displayTitle(p), kind: p.kind, icon: p.icon ?? null, parent_id: p.parentId, content_markdown: clip.text, truncated: clip.truncated, subpages: children.slice(0, 100) };
  },
};

const updateContentTool: ClaudeTool = {
  name: 'update_page_content',
  description: `Remplace TOUT le contenu d'une page par un nouveau contenu Markdown (le contenu actuel est perdu, l'historique des versions le conserve). ${mdHint} Pour ajouter du contenu sans rien effacer, utilise append_to_page.`,
  destructive: true,
  input_schema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'Identifiant de la page' },
      content_markdown: { type: 'string', description: 'Nouveau contenu complet en Markdown' },
    },
    required: ['page_id', 'content_markdown'],
  },
  run: async (input: Input) => {
    const p = requirePage(input.page_id);
    const doc = markdownToDoc(str(input.content_markdown));
    // Instantané de l'ancienne version dans l'historique avant d'écraser.
    await repo.addVersion({ id: uid(), pageId: p.id, content: p.content, title: p.title, at: Date.now() }).catch(() => undefined);
    const ed = openEditorFor(p.id);
    if (ed) ed.commands.setContent(doc as JSONContent, { emitUpdate: true });
    await updatePage(p.id, { content: ed ? ed.getJSON() : doc });
    return { ok: true, page_id: p.id, message: `Contenu de la page ${pageLabel(p)} remplacé.` };
  },
};

const appendTool: ClaudeTool = {
  name: 'append_to_page',
  description: `Ajoute du contenu Markdown à la fin d'une page (ou à l'emplacement du curseur si la page est ouverte et que position = "cursor"). ${mdHint}`,
  input_schema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'Identifiant de la page' },
      content_markdown: { type: 'string', description: 'Contenu à ajouter, en Markdown' },
      position: { type: 'string', enum: ['end', 'cursor'], description: 'Où insérer (défaut : end)' },
    },
    required: ['page_id', 'content_markdown'],
  },
  run: async (input: Input) => {
    const p = requirePage(input.page_id);
    const mdText = str(input.content_markdown);
    const ed = openEditorFor(p.id);
    if (ed) {
      const html = markdownToEditorHtml(mdText);
      if (input.position === 'cursor') ed.chain().insertContentAt(ed.state.selection.to, html).run();
      else ed.chain().insertContentAt(ed.state.doc.content.size, html).run();
      await updatePage(p.id, { content: ed.getJSON() });
    } else {
      const add = markdownToDoc(mdText).content;
      const content = isEmptyDoc(p.content) ? add : [...docContent(p.content), ...add];
      await updatePage(p.id, { content: { type: 'doc', content } });
    }
    return { ok: true, page_id: p.id, message: `Contenu ajouté à la page ${pageLabel(p)}.` };
  },
};

const renameTool: ClaudeTool = {
  name: 'rename_page',
  description: 'Renomme une page (et change éventuellement son icône emoji).',
  input_schema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'Identifiant de la page' },
      title: { type: 'string', description: 'Nouveau titre' },
      icon: { type: 'string', description: 'Nouvel emoji d\'icône (facultatif)' },
    },
    required: ['page_id', 'title'],
  },
  run: async (input: Input) => {
    const p = requirePage(input.page_id);
    const old = displayTitle(p);
    await updatePage(p.id, { title: str(input.title).trim(), ...(str(input.icon) ? { icon: str(input.icon) } : {}) });
    return { ok: true, page_id: p.id, message: `Page « ${old} » renommée en « ${str(input.title).trim()} ».` };
  },
};

const searchTool: ClaudeTool = {
  name: 'search_pages',
  description: 'Recherche des pages Prisme par mots-clés (titre et contenu). Requête vide = pages modifiées récemment. Renvoie identifiants, titres et extraits.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Mots-clés (peut être vide)' },
      limit: { type: 'integer', description: 'Nombre maximal de résultats (défaut : 10, max : 50)' },
    },
    required: ['query'],
  },
  run: async (input: Input) => {
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 10));
    const query = str(input.query);
    const pages = allPages();
    let hits = searchPagesLocal(pages, query, limit);
    if (query.trim() && repo.search) {
      // FTS5 (SQLite) : complète les résultats locaux.
      const fts = await repo.search(query, limit).catch(() => []);
      const known = new Set(hits.map(h => h.id));
      for (const f of fts) {
        const p = getPage(f.pageId);
        if (!p || p.trashed || known.has(p.id)) continue;
        hits.push({ id: p.id, title: displayTitle(p), kind: p.kind, parent: p.parentId ? displayTitle(getPage(p.parentId)) : null, excerpt: f.snippet, updatedAt: new Date(p.updatedAt).toISOString(), score: 0 });
      }
      hits = hits.slice(0, limit);
    }
    return { count: hits.length, results: hits.map(({ score: _s, ...h }) => h) };
  },
};

const openTool: ClaudeTool = {
  name: 'open_page',
  description: 'Ouvre une page dans Prisme (navigation de l\'utilisateur vers cette page).',
  input_schema: { type: 'object', properties: { page_id: { type: 'string', description: 'Identifiant de la page' } }, required: ['page_id'] },
  run: async (input: Input) => {
    const p = requirePage(input.page_id);
    openPage(p.id);
    return { ok: true, message: `Page ${pageLabel(p)} ouverte.` };
  },
};

const pinFileTool: ClaudeTool = {
  name: 'pin_file',
  description: 'Importe un fichier du disque dans la bibliothèque Prisme (copie dédupliquée, ou lien) et l\'épingle dans une page sous forme de puce. Sans page_id : page ouverte.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Chemin absolu du fichier sur le disque' },
      page_id: { type: 'string', description: 'Page où épingler (défaut : page ouverte)' },
      link: { type: 'boolean', description: 'Lier au lieu de copier (défaut : false)' },
    },
    required: ['path'],
  },
  run: async (input: Input) => {
    const pageId = str(input.page_id) || getActiveEditor()?.pageId || '';
    const p = requirePage(pageId);
    const vf = await files.importPath(str(input.path), { link: input.link === true });
    const pin = { type: FILE_PIN_NODE, attrs: { hash: vf.hash, name: vf.name, mime: vf.mime } };
    const ed = openEditorFor(p.id);
    if (ed && ed.schema.nodes[FILE_PIN_NODE]) {
      ed.chain().insertContentAt(ed.state.selection.to, [pin, { type: 'text', text: ' ' }]).run();
      await updatePage(p.id, { content: ed.getJSON() });
    } else {
      const para = { type: 'paragraph', content: [pin] };
      await updatePage(p.id, { content: { type: 'doc', content: isEmptyDoc(p.content) ? [para] : [...docContent(p.content), para] } });
    }
    return { ok: true, hash: vf.hash, name: vf.name, message: `Fichier « ${vf.name} » épinglé dans la page ${pageLabel(p)}.` };
  },
};

const trashTool: ClaudeTool = {
  name: 'trash_page',
  description: 'Met une page (et ses sous-pages) à la corbeille. Action destructive : l\'utilisateur doit confirmer.',
  destructive: true,
  input_schema: { type: 'object', properties: { page_id: { type: 'string', description: 'Identifiant de la page' } }, required: ['page_id'] },
  run: async (input: Input) => {
    const p = requirePage(input.page_id);
    await trashPage(p.id);
    return { ok: true, message: `Page ${pageLabel(p)} mise à la corbeille (restaurable depuis la corbeille).` };
  },
};

const propSchema = {
  type: 'array',
  description: 'Propriétés (colonnes) hors titre',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'person'] },
      options: { type: 'array', items: { type: 'string' }, description: 'Options pour select / multi_select / status' },
    },
    required: ['name', 'type'],
  },
};
const rowsSchema = {
  type: 'array',
  description: 'Lignes : objets {nom de propriété: valeur}. Le titre va dans la clé du nom de la colonne titre (ou "title"). Dates au format AAAA-MM-JJ, cases à cocher true/false, multi_select = tableau.',
  items: { type: 'object' },
};

const createDbTool: ClaudeTool = {
  name: 'create_database',
  description: 'Crée une base de données Prisme (vue tableau) avec ses propriétés et, au besoin, ses premières lignes.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Nom de la base' },
      icon: { type: 'string', description: 'Emoji (facultatif)' },
      parent_id: { type: 'string', description: 'Page parente (facultatif)' },
      title_property: { type: 'string', description: 'Nom de la colonne titre (défaut : « Nom »)' },
      properties: propSchema,
      rows: rowsSchema,
    },
    required: ['title', 'properties'],
  },
  run: async (input: Input) => {
    const out = await createDatabaseFromSpec({
      title: str(input.title), icon: str(input.icon) || undefined, parentId: str(input.parent_id) || null,
      titleProperty: str(input.title_property) || 'Nom', properties: input.properties, rows: Array.isArray(input.rows) ? input.rows as Record<string, unknown>[] : [],
    });
    return { ok: true, database_id: out.id, rows_added: out.rows, message: `Base « ${str(input.title)} » créée (${out.rows} ligne${out.rows > 1 ? 's' : ''}).` };
  },
};

const readDbTool: ClaudeTool = {
  name: 'read_database',
  description: 'Lit le schéma (propriétés, options) et les lignes d\'une base de données Prisme.',
  input_schema: {
    type: 'object',
    properties: {
      database_id: { type: 'string', description: 'Identifiant de la base (page de type database)' },
      limit: { type: 'integer', description: 'Nombre maximal de lignes (défaut : 100)' },
    },
    required: ['database_id'],
  },
  run: async (input: Input) => {
    const p = requirePage(input.database_id);
    if (p.kind !== 'database') throw new Error(`${pageLabel(p)} n'est pas une base de données.`);
    const schema = await getSchema(p.id);
    const props = schema?.properties ?? [];
    const rows = rowsOf(p.id).slice(0, Math.min(500, Math.max(1, Number(input.limit) || 100)));
    return {
      database_id: p.id, title: displayTitle(p),
      properties: props.map(d => ({ name: d.name, type: d.type, ...(d.options?.length ? { options: d.options.map(o => o.name) } : {}) })),
      row_count: rowsOf(p.id).length,
      rows: rows.map(r => {
        const values: Record<string, unknown> = { id: r.id };
        for (const d of props) values[d.name] = d.type === 'title' ? r.title : r.props?.[d.id] ?? null;
        return values;
      }),
    };
  },
};

const addRowsTool: ClaudeTool = {
  name: 'add_database_rows',
  description: 'Ajoute des lignes à une base de données Prisme existante (valeurs indexées par nom de propriété). Utilise read_database pour connaître les propriétés.',
  input_schema: {
    type: 'object',
    properties: { database_id: { type: 'string', description: 'Identifiant de la base' }, rows: rowsSchema },
    required: ['database_id', 'rows'],
  },
  run: async (input: Input) => {
    const p = requirePage(input.database_id);
    if (p.kind !== 'database') throw new Error(`${pageLabel(p)} n'est pas une base de données.`);
    const n = await addRowsToDatabase(p.id, Array.isArray(input.rows) ? input.rows as Record<string, unknown>[] : []);
    return { ok: true, rows_added: n, message: `${n} ligne${n > 1 ? 's' : ''} ajoutée${n > 1 ? 's' : ''} à ${pageLabel(p)}.` };
  },
};

// ───────────────────────────── Bases : aides partagées (outil + /claude) ─────────────────────────────

export async function createDatabaseFromSpec(spec: { title: string; icon?: string; parentId: string | null; titleProperty?: string; properties: unknown; rows: Record<string, unknown>[] }): Promise<{ id: string; rows: number }> {
  const titleName = (spec.titleProperty || 'Nom').trim() || 'Nom';
  const props = normalizeProperties(spec.properties, titleName);
  const rows = spec.rows.slice(0, 500).map(r => normalizeRow(r, props, titleName));
  const id = await createDatabase({ title: spec.title.trim() || 'Nouvelle base', icon: spec.icon, parentId: spec.parentId, properties: [{ name: titleName, type: 'title' }, ...props] });
  for (const values of rows) await addRow(id, values);
  return { id, rows: rows.length };
}

export async function addRowsToDatabase(dbId: string, rows: Record<string, unknown>[]): Promise<number> {
  const schema = await getSchema(dbId);
  if (!schema) throw new Error('Schéma de la base introuvable.');
  const props: PropertyDef[] = schema.properties.map(p => ({ ...p, options: p.options ? [...p.options] : p.options }));
  const titleName = props.find(p => p.type === 'title')?.name ?? 'Nom';
  const before = JSON.stringify(props.map(p => p.options?.length ?? 0));
  const values = rows.slice(0, 500).map(r => normalizeRow(r, props, titleName));
  if (JSON.stringify(props.map(p => p.options?.length ?? 0)) !== before) {
    // Nouvelles options de sélection créées par Claude : on les enregistre dans le schéma.
    await saveSchema({ ...schema, properties: props.map(p => ({ ...p, options: p.options?.map(o => ({ ...o, id: o.id || uid().slice(0, 8) })) })) });
  }
  for (const v of values) await addRow(dbId, v);
  return values.length;
}

export const internalTools: ClaudeTool[] = [
  searchTool, readPageTool, createPageTool, appendTool, updateContentTool, renameTool, openTool, pinFileTool, trashTool,
  createDbTool, readDbTool, addRowsTool,
];
export const INTERNAL_TOOL_NAMES = new Set(internalTools.map(t => t.name));

/** Résumé lisible d'un appel d'outil interne (affiché dans la demande de confirmation). */
export function describeInternalCall(name: string, input: Input): string | null {
  const page = (k = 'page_id') => { const p = getPage(str(input[k])); return p ? pageLabel(p) : `(id ${str(input[k])})`; };
  switch (name) {
    case 'update_page_content': return `Remplacer tout le contenu de la page ${page()} par un nouveau texte (${str(input.content_markdown).length.toLocaleString('fr-FR')} caractères). L'ancienne version reste dans l'historique.`;
    case 'trash_page': {
      const p = getPage(str(input.page_id));
      const n = p ? allPages().filter(x => x.parentId === p.id && !x.trashed).length : 0;
      return `Mettre la page ${page()} à la corbeille${n ? ` avec ses ${n} sous-page${n > 1 ? 's' : ''}` : ''}.`;
    }
    case 'create_page': return `Créer la page « ${str(input.title)} ».`;
    case 'append_to_page': return `Ajouter du contenu à la page ${page()}.`;
    case 'rename_page': return `Renommer la page ${page()} en « ${str(input.title)} ».`;
    case 'pin_file': return `Épingler le fichier « ${str(input.path)} ».`;
    case 'create_database': return `Créer la base « ${str(input.title)} ».`;
    case 'add_database_rows': return `Ajouter ${Array.isArray(input.rows) ? input.rows.length : 0} ligne(s) à la base ${page('database_id')}.`;
    default: return null;
  }
}
