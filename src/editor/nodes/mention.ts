/* eslint-disable @typescript-eslint/no-explicit-any */
// Mentions « @ » : pages (lien cliquable), dates (@aujourd'hui, @demain…), rappels (@rappel → notification).
import Mention from '@tiptap/extension-mention';
import { mergeAttributes, type Editor } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { createElement } from 'react';
import { addDays, addHours, setHours, setMinutes, startOfDay } from 'date-fns';
import { allPages, createPage, displayTitle, isInTrash, usePages } from '../../db/pages';
import { currentPageId, openPage, toast } from '../../ui/appState';
import { fuzzyBest } from '../fuzzy';
import { formatMentionDate, formatReminder, fromISODate, parseDateQuery, toISODate } from '../dates';
import { addReminder, ensureNotificationPermission, getReminder, updateReminder } from '../reminders';
import { caretAnchor, pickDate } from '../ui/overlays';
import { suggestionRenderer } from '../ui/SuggestionList';

export const MentionPluginKey = new PluginKey('prismeMention');

type MentionItem =
  | { type: 'page'; id: string; title: string; icon: string }
  | { type: 'new-page'; title: string }
  | { type: 'date'; date: Date }
  | { type: 'pick-date' }
  | { type: 'reminder'; at: number }
  | { type: 'pick-reminder' };

/** Texte brut d'une mention (export, copier-coller). */
export function mentionText(attrs: Record<string, unknown>): string {
  if (attrs.kind === 'date' && typeof attrs.id === 'string') return '@' + formatMentionDate(fromISODate(attrs.id));
  if (attrs.kind === 'reminder' && attrs.date) return '⏰ ' + formatReminder(Number(new Date(String(attrs.date))));
  if (attrs.kind === 'page' && typeof attrs.id === 'string') { const p = usePages.getState().pages[attrs.id]; if (p) return '@' + displayTitle(p); }
  return '@' + String(attrs.label ?? attrs.id ?? '');
}

export function insertDateMention(editor: Editor, at: number, d: Date) {
  const iso = toISODate(d);
  editor.chain().focus().insertContentAt(at, [{ type: 'mention', attrs: { id: iso, label: formatMentionDate(d), kind: 'date' } }, { type: 'text', text: ' ' }]).run();
}

/** Crée le rappel (kv 'reminders') et insère la mention. Le texte du rappel = texte du bloc courant. */
export async function insertReminderMention(editor: Editor, at: number, ts: number) {
  const $at = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size));
  const blockText = $at.parent.textContent.trim();
  const pageId = currentPageId();
  const r = await addReminder({ pageId, at: ts, text: blockText || (pageId ? displayTitle(usePages.getState().pages[pageId]) : 'Rappel') });
  editor.chain().focus().insertContentAt(at, [{ type: 'mention', attrs: { id: r.id, label: formatReminder(ts), kind: 'reminder', date: new Date(ts).toISOString() } }, { type: 'text', text: ' ' }]).run();
  void ensureNotificationPermission();
  toast(`Rappel programmé : ${formatReminder(ts)}`, 'success');
}

function mentionItems(query: string): MentionItem[] {
  const q = query.trim();
  const out: MentionItem[] = [];
  // Pages
  const pages = allPages().filter(p => !isInTrash(p.id));
  const scored = q
    ? pages.map(p => ({ p, s: fuzzyBest(q, [[displayTitle(p), 1]]) })).filter((x): x is { p: typeof pages[number]; s: number } => x.s !== null).sort((a, b) => b.s - a.s)
    : pages.sort((a, b) => b.updatedAt - a.updatedAt).map(p => ({ p, s: 0 }));
  for (const { p } of scored.slice(0, q ? 6 : 4)) out.push({ type: 'page', id: p.id, title: displayTitle(p), icon: p.icon || (p.kind === 'database' ? '🗃️' : '📄') });
  // Dates
  const parsed = parseDateQuery(q);
  if (parsed) out.push({ type: 'date', date: parsed });
  const today = startOfDay(new Date());
  const dateCands: [string, Date][] = [["aujourd'hui date", today], ['demain date', addDays(today, 1)], ['hier date', addDays(today, -1)]];
  for (const [k, d] of dateCands) if ((!q || fuzzyBest(q, [[k, 1]]) !== null) && !(parsed && toISODate(parsed) === toISODate(d))) out.push({ type: 'date', date: d });
  if (!q || fuzzyBest(q, [['date choisir calendrier', 1]]) !== null) out.push({ type: 'pick-date' });
  // Rappels
  if (!q || fuzzyBest(q, [['rappel notification alarme', 1]]) !== null) {
    if (q) {
      out.push({ type: 'reminder', at: addHours(new Date(), 1).getTime() });
      out.push({ type: 'reminder', at: setMinutes(setHours(addDays(new Date(), 1), 9), 0).getTime() });
    }
    out.push({ type: 'pick-reminder' });
  }
  if (q && !/^(rappel|date)/i.test(q)) out.push({ type: 'new-page', title: q });
  return out;
}

const icon = (s: string) => createElement('span', { className: 'emoji' }, s);

export const PrismeMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: { default: 'page', parseHTML: el => el.getAttribute('data-kind') ?? 'page', renderHTML: a => ({ 'data-kind': a.kind }) },
      date: { default: null, parseHTML: el => el.getAttribute('data-date'), renderHTML: a => (a.date ? { 'data-date': a.date } : {}) },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('span');
      dom.className = 'mention'; dom.contentEditable = 'false';
      let lastPage = current.attrs.kind === 'page' ? usePages.getState().pages[current.attrs.id] : undefined;
      const render = () => {
        const a = current.attrs;
        dom.dataset.kind = a.kind;
        dom.classList.remove('missing', 'overdue');
        if (a.kind === 'page') {
          const p = usePages.getState().pages[a.id];
          dom.textContent = '';
          const i = document.createElement('span'); i.className = 'mention-icon'; i.textContent = p?.icon || '📄';
          const t = document.createElement('span'); t.className = 'mention-title'; t.textContent = p ? displayTitle(p) : (a.label || 'Page supprimée');
          dom.append(i, t);
          if (!p || isInTrash(p.id)) dom.classList.add('missing');
          dom.title = p ? 'Ouvrir la page' : 'Page introuvable';
        } else if (a.kind === 'date') {
          dom.textContent = '@' + formatMentionDate(fromISODate(String(a.id)));
          dom.title = 'Cliquer pour changer la date';
        } else if (a.kind === 'reminder') {
          const ts = new Date(String(a.date)).getTime();
          dom.textContent = '⏰ ' + formatReminder(ts);
          if (ts < Date.now()) dom.classList.add('overdue');
          dom.title = 'Rappel — cliquer pour modifier';
        } else dom.textContent = '@' + (a.label ?? a.id ?? '');
      };
      render();
      const unsub = current.attrs.kind === 'page'
        ? usePages.subscribe(s => { const p = s.pages[current.attrs.id]; if (p !== lastPage) { lastPage = p; render(); } })
        : () => {};
      const setAttrs = (patch: Record<string, unknown>) => {
        const pos = getPos(); if (typeof pos !== 'number') return;
        editor.chain().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }); return true; }).run();
      };
      dom.addEventListener('mousedown', e => e.preventDefault());
      dom.addEventListener('click', async e => {
        e.preventDefault(); e.stopPropagation();
        const a = current.attrs;
        if (a.kind === 'page') { if (usePages.getState().pages[a.id]) openPage(a.id); else toast('Cette page n’existe plus.', 'warning'); return; }
        if (!editor.isEditable) return;
        if (a.kind === 'date') {
          const d = await pickDate(dom, { withTime: false, value: fromISODate(String(a.id)), title: 'Changer la date' });
          if (d) setAttrs({ id: toISODate(d), label: formatMentionDate(d) });
        } else if (a.kind === 'reminder') {
          const r = await getReminder(String(a.id));
          const d = await pickDate(dom, { withTime: true, reminder: true, value: new Date(String(a.date)), title: 'Modifier le rappel' });
          if (d) {
            if (r) await updateReminder(r.id, { at: d.getTime(), done: false });
            else await addReminder({ id: String(a.id), pageId: currentPageId(), at: d.getTime(), text: dom.parentElement?.textContent?.trim() ?? 'Rappel' });
            setAttrs({ date: d.toISOString(), label: formatReminder(d.getTime()) });
          }
        }
      });
      return {
        dom,
        update: n => { if (n.type !== current.type) return false; current = n; lastPage = n.attrs.kind === 'page' ? usePages.getState().pages[n.attrs.id] : undefined; render(); return true; },
        stopEvent: e => e.type === 'click' || e.type === 'mousedown',
        ignoreMutation: () => true,
        destroy: unsub,
      };
    };
  },
}).configure({
  HTMLAttributes: { class: 'mention' },
  deleteTriggerWithBackspace: true,
  renderText: ({ node }) => mentionText(node.attrs),
  renderHTML: ({ options, node }) => ['span', mergeAttributes(options.HTMLAttributes), mentionText(node.attrs)],
  suggestion: {
    char: '@',
    pluginKey: MentionPluginKey,
    allowSpaces: true,
    allowedPrefixes: [' ', ' ', '('],
    floatingUi: { strategy: 'fixed' },
    items: ({ query }) => mentionItems(query) as never[],
    command: ({ editor, range, props }) => {
      const it = props as unknown as MentionItem;
      const insert = (attrs: Record<string, unknown>) =>
        editor.chain().focus().insertContentAt(range, [{ type: 'mention', attrs }, { type: 'text', text: ' ' }]).run();
      switch (it.type) {
        case 'page': insert({ id: it.id, label: it.title, kind: 'page' }); break;
        case 'new-page':
          void createPage({ title: it.title, parentId: currentPageId() }).then(p => insert({ id: p.id, label: p.title, kind: 'page' }));
          break;
        case 'date': insert({ id: toISODate(it.date), label: formatMentionDate(it.date), kind: 'date' }); break;
        case 'reminder': {
          editor.chain().focus().deleteRange(range).run();
          void insertReminderMention(editor, range.from, it.at);
          break;
        }
        case 'pick-date':
        case 'pick-reminder': {
          editor.chain().focus().deleteRange(range).run();
          const at = editor.state.selection.from;
          const reminder = it.type === 'pick-reminder';
          void pickDate(caretAnchor(editor.view), { withTime: reminder, reminder, title: reminder ? 'Rappel' : 'Date' }).then(d => {
            if (!d) { editor.commands.focus(); return; }
            if (reminder) void insertReminderMention(editor, at, d.getTime()); else insertDateMention(editor, at, d);
          });
          break;
        }
      }
    },
    render: suggestionRenderer<any, any>({
      pluginKey: MentionPluginKey,
      autoExitOnEmptySpace: true,
      emptyText: 'Aucune page ni date',
      toList: (items: unknown[]) => (items as MentionItem[]).map((it, i) => {
        switch (it.type) {
          case 'page': return { key: 'p' + it.id, title: it.title, icon: icon(it.icon), group: 'Pages' };
          case 'new-page': return { key: 'new' + i, title: `Nouvelle page « ${it.title} »`, icon: icon('➕'), group: 'Pages' };
          case 'date': return { key: 'd' + toISODate(it.date) + i, title: formatMentionDate(it.date), description: toISODate(it.date).split('-').reverse().join('/'), icon: icon('📅'), group: 'Dates' };
          case 'pick-date': return { key: 'pd', title: 'Choisir une date…', icon: icon('🗓️'), group: 'Dates' };
          case 'reminder': return { key: 'r' + it.at, title: `Rappel ${formatReminder(it.at)}`, icon: icon('⏰'), group: 'Rappels' };
          case 'pick-reminder': return { key: 'pr', title: 'Rappel…', description: 'Notification à la date et l’heure choisies', icon: icon('⏰'), group: 'Rappels' };
        }
      }),
    }),
  },
});
