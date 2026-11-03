// Insertion des puces dans l'éditeur : placeholder « importation… » suivi à travers les modifications
// (décoration ProseMirror), puis insertion dans l'ordre de dépôt, avec espaces autour comme un mot.
import type { Editor } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { VaultFile } from '../db/types';
import { toast } from '../ui/appState';
import { FILE_PIN_NODE } from './api';
import { fileKind, iconSvg, KIND_META, truncateMiddle } from './kinds';
import { importJobs, runJob, runLimited, type PinJob } from './jobs';

export type PinAttrs = { hash: string; name: string; mime: string; linked: boolean };
export const pinAttrs = (f: VaultFile): PinAttrs => ({ hash: f.hash, name: f.name, mime: f.mime, linked: !!f.linked });

/** Espaces à ajouter autour d'une puce insérée entre `before` (caractère précédent) et `after` (suivant). */
export function spacing(before: string, after: string): { lead: boolean; trail: boolean } {
  const lead = before !== '' && !/[\s([{«“‘'"  /]$/.test(before);
  const trail = after === '' || !/^[\s.,)\]}»”’'"…  /]/.test(after);
  return { lead, trail };
}

// ───────────── Placeholders ─────────────
export const placeholderKey = new PluginKey<DecorationSet>('filePinPlaceholders');
type PhMeta = { add?: { id: string; pos: number; el: HTMLElement }; remove?: string };

export const placeholderPlugin = () => new Plugin<DecorationSet>({
  key: placeholderKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(placeholderKey) as PhMeta | undefined;
      if (meta?.add) next = next.add(tr.doc, [Decoration.widget(meta.add.pos, meta.add.el, { id: meta.add.id, key: meta.add.id, side: 1, ignoreSelection: true })]);
      if (meta?.remove) next = next.remove(next.find(undefined, undefined, spec => spec.id === meta.remove));
      return next;
    },
  },
  props: { decorations: state => placeholderKey.getState(state) },
});

export function findPlaceholder(state: EditorState, id: string): number | null {
  const found = placeholderKey.getState(state)?.find(undefined, undefined, spec => spec.id === id);
  return found?.length ? found[0].from : null;
}

function placeholderElement(jobs: PinJob[]) {
  const el = document.createElement('span');
  el.className = 'file-pin file-pin-pending';
  el.contentEditable = 'false';
  el.setAttribute('aria-live', 'polite');
  const kind = fileKind(jobs[0]?.name ?? '');
  el.innerHTML = `<span class="file-pin-icon"><span class="file-pin-spinner"></span></span><span class="file-pin-name"></span><span class="file-pin-pct"></span><span class="file-pin-bar"></span>`;
  el.style.setProperty('--kind', KIND_META[kind].color);
  const name = el.querySelector('.file-pin-name') as HTMLElement;
  const pct = el.querySelector('.file-pin-pct') as HTMLElement;
  const update = (current: number, done: number, total: number) => {
    const job = jobs[current];
    name.textContent = job ? truncateMiddle(job.name, 24) + (jobs.length > 1 ? ` (${current + 1}/${jobs.length})` : '') : '';
    const p = total > 0 ? Math.min(1, done / total) : 0;
    pct.textContent = total > 0 ? `${Math.round(p * 100)} %` : '…';
    el.style.setProperty('--p', String(p));
  };
  update(0, 0, 0);
  return { el, update };
}

const pinType = (editor: Editor) => editor.schema.nodes[FILE_PIN_NODE];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Position où une puce peut aller. Si `pos` est entre deux blocs ou dans un bloc qui n'accepte pas
 * les puces (bloc de code, titre de page…), on prévoit un nouveau paragraphe juste après. */
export function resolvePinPosition(state: EditorState, pos: number): { pos: number; newParagraphAt?: number } {
  const type = state.schema.nodes[FILE_PIN_NODE];
  const p = clamp(pos, 0, state.doc.content.size);
  const $p = state.doc.resolve(p);
  if (type && $p.parent.inlineContent && $p.parent.canReplaceWith($p.index(), $p.index(), type)) return { pos: p };
  const at = $p.parent.inlineContent && $p.depth > 0 ? $p.after() : p;
  return { pos: at + 1, newParagraphAt: at };
}

/** Insère une puce à la place du placeholder `id`. */
function insertAtPlaceholder(editor: Editor, id: string, file: VaultFile): boolean {
  if (editor.isDestroyed) return false;
  const type = pinType(editor); if (!type) return false;
  const { state } = editor;
  const pos = findPlaceholder(state, id); if (pos == null) return false;
  const $pos = state.doc.resolve(pos);
  const before = $pos.parentOffset > 0 ? state.doc.textBetween(pos - 1, pos, '', '￼') : '';
  const after = $pos.parentOffset < $pos.parent.content.size ? state.doc.textBetween(pos, pos + 1, '', '￼') : '';
  const { lead, trail } = spacing(before, after);
  const nodes: PMNode[] = [];
  if (lead) nodes.push(state.schema.text(' '));
  nodes.push(type.create(pinAttrs(file)));
  if (trail) nodes.push(state.schema.text(' '));
  const tr = state.tr.insert(pos, Fragment.fromArray(nodes));
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

/**
 * Importe des fichiers et insère leurs puces à `pos` (position ProseMirror), dans l'ordre,
 * au fur et à mesure (une grosse vidéo ne bloque pas les fichiers qui la précèdent).
 */
export async function pinJobsAt(editor: Editor, pos: number, jobs: PinJob[]): Promise<VaultFile[]> {
  if (!jobs.length) return [];
  if (editor.isDestroyed || !pinType(editor) || !editor.isEditable) {
    const files = await importJobs(jobs);
    if (files.length) toast("Cette zone n'accepte pas les fichiers épinglés : ils ont été ajoutés au vault.", 'info');
    return files;
  }
  const id = crypto.randomUUID();
  const ph = placeholderElement(jobs);
  const target = resolvePinPosition(editor.state, pos);
  const para = editor.schema.nodes.paragraph;
  let tr = editor.state.tr;
  let createdParagraph = false;
  if (target.newParagraphAt != null && para) {
    tr = tr.insert(target.newParagraphAt, para.create());
    createdParagraph = tr.docChanged;
  }
  const at = createdParagraph ? target.pos : clamp(pos, 0, tr.doc.content.size);
  editor.view.dispatch(tr.setMeta(placeholderKey, { add: { id, pos: at, el: ph.el } } satisfies PhMeta));

  const results: (VaultFile | Error | undefined)[] = new Array(jobs.length);
  const progress = jobs.map(() => ({ done: 0, total: 0 }));
  let next = 0; let inserted = 0;
  const refresh = () => { const p = progress[next]; if (p) ph.update(next, p.done, p.total); };
  const flush = () => {
    while (next < jobs.length && results[next] !== undefined) {
      const r = results[next++];
      if (r && !(r instanceof Error) && insertAtPlaceholder(editor, id, r)) inserted++;
    }
    refresh();
  };
  await runLimited(jobs, 3, async (job, i) => {
    results[i] = await runJob(job, (done, total) => { progress[i] = { done, total }; if (i === next) refresh(); });
    flush();
  });

  if (!editor.isDestroyed) {
    const end = editor.state.tr.setMeta(placeholderKey, { remove: id } satisfies PhMeta).setMeta('addToHistory', false);
    const phPos = findPlaceholder(editor.state, id);
    if (createdParagraph && !inserted && phPos != null) {
      const $p = editor.state.doc.resolve(phPos);
      if ($p.parent.type === para && $p.parent.content.size === 0 && $p.depth > 0) end.delete($p.before(), $p.after());
    }
    editor.view.dispatch(end);
  } else if (results.some(r => r && !(r instanceof Error))) {
    toast('Fichiers ajoutés au vault, mais la page a été fermée avant leur insertion.', 'warning');
  }
  return results.filter((r): r is VaultFile => !!r && !(r instanceof Error));
}

/** Insère directement des puces de fichiers déjà présents dans le vault (glisser interne, Claude…). */
export function insertPins(editor: Editor, pos: number, files: VaultFile[]): boolean {
  const type = pinType(editor);
  if (!type || !files.length || editor.isDestroyed) return false;
  const target = resolvePinPosition(editor.state, pos);
  const content = files.flatMap((f, i) => [...(i ? [{ type: 'text', text: ' ' }] : []), { type: FILE_PIN_NODE, attrs: pinAttrs(f) }]);
  const $p = editor.state.doc.resolve(target.newParagraphAt ?? target.pos);
  const before = target.newParagraphAt == null && $p.parentOffset > 0 ? editor.state.doc.textBetween(target.pos - 1, target.pos, '', '￼') : '';
  const after = target.newParagraphAt == null && $p.parentOffset < $p.parent.content.size ? editor.state.doc.textBetween(target.pos, target.pos + 1, '', '￼') : '';
  const { lead, trail } = spacing(before, after);
  const inline = [...(lead ? [{ type: 'text', text: ' ' }] : []), ...content, ...(trail ? [{ type: 'text', text: ' ' }] : [])];
  if (target.newParagraphAt != null) return editor.chain().focus().insertContentAt(target.newParagraphAt, { type: 'paragraph', content: inline }).run();
  return editor.chain().focus().insertContentAt(target.pos, inline).run();
}

/** Petite icône de type (chaîne SVG) pour les placeholders et badges. */
export const kindIcon = (name: string, mime = '') => iconSvg(fileKind(name, mime));
