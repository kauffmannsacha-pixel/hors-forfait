// Sources du calendrier unifié : Google Agenda (plusieurs comptes/agendas), propriétés « date » des bases Prisme,
// publications programmées (kv `publish:queue`). Fonctions de dates pures (testées) + chargeurs.
import { repo } from '../../db/store';
import { allPages } from '../../db/pages';
import { getSchema, rowsOf } from '../../database/api';
import type { CalendarItem } from '../api';
import { errorMessage } from '../core/errors';
import { localDayKey } from '../core/format';
import { calendarAccounts, listCalendars, listEvents, type GCalendar, type GEventTime } from '../google/calendar';

export interface CalEvent {
  key: string; source: CalendarItem['source']; title: string; start: Date; end: Date; allDay: boolean;
  color: string; calendar: string; sourceKey: string;
  pageId?: string; accountId?: string; calendarId?: string; eventId?: string; htmlLink?: string;
  location?: string; description?: string; editable: boolean;
}
export interface CalPrefs { hidden: string[]; initialized?: boolean }
export interface CalSource { key: string; label: string; color: string; kind: CalendarItem['source']; writable?: boolean; accountId?: string; calendarId?: string; account?: string }

export const PRISME_COLOR = '#1baf7a';   // dates des bases
export const PUBLISH_COLOR = '#eb6834';  // publications programmées
const PREFS_KV = 'connectors:calendar:prefs';
/** Bases synchronisées par les connecteurs : masquées par défaut (trop de lignes datées). */
const NOISY_DBS = ['Paiements Stripe', 'Messages Discord'];

// ── Dates (pur) ──────────────────────────────────────────────
const DAY = 86_400_000;
export const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfWeek = (d: Date) => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); }; // lundi
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** 42 jours (6 semaines, du lundi) couvrant le mois de `d`. */
export const monthGrid = (d: Date) => { const first = new Date(d.getFullYear(), d.getMonth(), 1); const s = startOfWeek(first); return Array.from({ length: 42 }, (_, i) => addDays(s, i)); };
const parseLocalDay = (s: string) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd); };

/** Valeur d'une propriété date (chaîne ISO, AAAA-MM-JJ, nombre, Date, {start,end}) → plage. */
export function parseDateValue(v: unknown): { start: Date; end?: Date; allDay: boolean } | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { start: v, allDay: false };
  if (typeof v === 'number') { const ms = v < 1e11 ? v * 1000 : v; return { start: new Date(ms), allDay: false }; }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { start: parseLocalDay(s), allDay: true };
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : { start: new Date(t), allDay: false };
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const a = parseDateValue(o.start ?? o.date ?? o.from ?? o.value);
    if (!a) return null;
    const b = parseDateValue(o.end ?? o.to);
    return { start: a.start, end: b?.start, allDay: a.allDay && (!b || b.allDay) };
  }
  return null;
}

/** Heure Google → Date (journée entière : `date`, fin exclusive). */
export function fromGoogleTime(t: GEventTime): { date: Date; allDay: boolean } {
  if (t.date) return { date: parseLocalDay(t.date), allDay: true };
  return { date: new Date(t.dateTime ?? 0), allDay: false };
}

/** L'événement touche-t-il l'intervalle [from, to[ ? */
export const overlaps = (e: Pick<CalEvent, 'start' | 'end'>, from: Date, to: Date) => e.start < to && e.end > from;

/** Événements d'un jour donné (journées entières d'abord, puis par heure). */
export function eventsOn(events: CalEvent[], day: Date): CalEvent[] {
  const from = startOfDay(day); const to = addDays(from, 1);
  return events.filter(e => overlaps(e, from, to)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title, 'fr'));
}

/** Disposition en colonnes des événements horaires qui se chevauchent (vue Semaine). */
export function layoutDay<T extends { start: Date; end: Date }>(events: T[]): { ev: T; col: number; cols: number }[] {
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
  const out: { ev: T; col: number; cols: number }[] = [];
  let cluster: { ev: T; col: number; cols: number }[] = []; let colsEnd: number[] = []; let clusterEnd = -Infinity;
  const flush = () => { const n = colsEnd.length; for (const x of cluster) x.cols = n; out.push(...cluster); cluster = []; colsEnd = []; };
  for (const ev of sorted) {
    const s = ev.start.getTime(); const e = Math.max(ev.end.getTime(), s + 15 * 60_000);
    if (s >= clusterEnd && cluster.length) flush();
    let col = colsEnd.findIndex(end => end <= s);
    if (col === -1) { col = colsEnd.length; colsEnd.push(e); } else colsEnd[col] = e;
    cluster.push({ ev, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd === -Infinity ? e : clusterEnd, e);
  }
  if (cluster.length) flush();
  return out;
}

// ── Préférences ──────────────────────────────────────────────
export const getPrefs = async (): Promise<CalPrefs> => (await repo.kvGet<CalPrefs>(PREFS_KV)) ?? { hidden: [] };
export const savePrefs = (p: CalPrefs) => repo.kvSet(PREFS_KV, p);

// ── Chargeurs ────────────────────────────────────────────────
async function googleSource(from: Date, to: Date, force: boolean) {
  const events: CalEvent[] = []; const sources: CalSource[] = []; const errors: string[] = []; let stale = false;
  for (const acc of await calendarAccounts()) {
    if (acc.needsReauth) { errors.push(`${acc.email} : reconnexion Google nécessaire.`); continue; }
    let cals: GCalendar[] = [];
    try { cals = await listCalendars(acc.id, force); } catch (e) { errors.push(`${acc.email} : ${errorMessage(e)}`); continue; }
    for (const c of cals) {
      const key = `g:${acc.id}:${c.id}`;
      sources.push({ key, label: c.summary, color: c.color, kind: 'google', writable: c.writable, accountId: acc.id, calendarId: c.id, account: acc.email });
    }
    await Promise.all(cals.map(async c => {
      const key = `g:${acc.id}:${c.id}`;
      try {
        const r = await listEvents(acc.id, c.id, from, to, force);
        stale ||= r.stale;
        for (const e of r.events) {
          const s = fromGoogleTime(e.start); const en = fromGoogleTime(e.end);
          events.push({
            key: `${key}:${e.id}`, source: 'google', title: e.summary, start: s.date, end: en.date > s.date ? en.date : new Date(s.date.getTime() + (s.allDay ? DAY : 30 * 60_000)), allDay: s.allDay,
            color: c.color, calendar: c.summary, sourceKey: key, accountId: acc.id, calendarId: c.id, eventId: e.id, htmlLink: e.htmlLink,
            location: e.location, description: e.description, editable: c.writable,
          });
        }
      } catch (e) { errors.push(`${c.summary} : ${errorMessage(e)}`); }
    }));
  }
  return { events, sources, errors, stale };
}

async function prismeSource(from: Date, to: Date) {
  const events: CalEvent[] = []; const sources: CalSource[] = [];
  for (const db of allPages().filter(p => p.kind === 'database' && !p.trashed)) {
    const schema = await getSchema(db.id);
    const dateProps = schema?.properties.filter(p => p.type === 'date') ?? [];
    if (!dateProps.length) continue;
    const key = `db:${db.id}`;
    sources.push({ key, label: `${db.icon ? db.icon + ' ' : ''}${db.title || 'Base sans titre'}`, color: PRISME_COLOR, kind: 'prisme' });
    for (const row of rowsOf(db.id)) {
      for (const prop of dateProps) {
        const r = parseDateValue(row.props?.[prop.id]);
        if (!r) continue;
        const end = r.end && r.end > r.start ? (r.allDay ? addDays(r.end, 1) : r.end) : r.allDay ? addDays(r.start, 1) : new Date(r.start.getTime() + 30 * 60_000);
        const ev: CalEvent = {
          key: `${key}:${row.id}:${prop.id}`, source: 'prisme', title: row.title || 'Sans titre', start: r.start, end, allDay: r.allDay,
          color: PRISME_COLOR, calendar: `${db.title} · ${prop.name}`, sourceKey: key, pageId: row.id, editable: false,
        };
        if (overlaps(ev, from, to)) events.push(ev);
      }
    }
  }
  return { events, sources };
}

const pick = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) { const v = k.split('.').reduce<unknown>((a, p) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[p] : undefined), o); if (v != null && v !== '') return v; } return undefined; };

/** Publications programmées par le module publication (format tolérant). */
export async function publicationEvents(from: Date, to: Date): Promise<CalEvent[]> {
  const raw = await repo.kvGet<unknown>('publish:queue').catch(() => undefined);
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items) ? (raw as { items: unknown[] }).items : [];
  const out: CalEvent[] = [];
  list.forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    const o = it as Record<string, unknown>;
    const when = parseDateValue(pick(o, ['publishAt', 'scheduledAt', 'scheduledFor', 'publishDate', 'status.publishAt', 'meta.publishAt', 'date', 'at']));
    if (!when) return;
    const status = String(pick(o, ['status', 'state']) ?? '');
    if (/^(failed|cancel|annul)/i.test(status)) return;
    const title = String(pick(o, ['title', 'videoTitle', 'snippet.title', 'meta.title', 'name']) ?? 'Publication');
    const ev: CalEvent = {
      key: `pub:${String(pick(o, ['id', 'jobId']) ?? i)}`, source: 'publication', title: `▶︎ ${title}`, start: when.start, end: new Date(when.start.getTime() + 30 * 60_000), allDay: false,
      color: PUBLISH_COLOR, calendar: String(pick(o, ['channelTitle', 'channel', 'channelId']) ?? 'Publication YouTube'), sourceKey: 'pub',
      pageId: typeof o.pageId === 'string' ? o.pageId : undefined, editable: false,
    };
    if (overlaps(ev, from, to)) out.push(ev);
  });
  return out;
}

export interface LoadResult { events: CalEvent[]; sources: CalSource[]; errors: string[]; stale: boolean }

/** Charge toutes les sources sur [from, to[ (les sources masquées sont filtrées par l'appelant). */
export async function loadCalendar(from: Date, to: Date, force = false): Promise<LoadResult> {
  const [g, p, pub] = await Promise.all([
    googleSource(from, to, force).catch(e => ({ events: [] as CalEvent[], sources: [] as CalSource[], errors: [errorMessage(e)], stale: false })),
    prismeSource(from, to).catch(() => ({ events: [] as CalEvent[], sources: [] as CalSource[] })),
    publicationEvents(from, to).catch(() => [] as CalEvent[]),
  ]);
  const sources = [...g.sources, ...p.sources, { key: 'pub', label: 'Publications programmées', color: PUBLISH_COLOR, kind: 'publication' as const }];
  return { events: [...g.events, ...p.events, ...pub], sources, errors: g.errors, stale: g.stale };
}

/** Sources masquées par défaut au premier affichage. */
export function defaultHidden(sources: CalSource[]): string[] {
  return sources.filter(s => s.kind === 'prisme' && NOISY_DBS.some(n => s.label.endsWith(n))).map(s => s.key);
}

export const toCalendarItem = (e: CalEvent): CalendarItem => ({
  id: e.key, source: e.source, title: e.title, start: e.allDay ? localDayKey(e.start) : e.start.toISOString(), end: e.allDay ? localDayKey(e.end) : e.end.toISOString(), allDay: e.allDay,
  calendar: e.calendar, color: e.color, pageId: e.pageId, accountId: e.accountId, calendarId: e.calendarId, eventId: e.eventId, htmlLink: e.htmlLink, location: e.location, description: e.description,
});

/** Événements visibles (préférences appliquées) — utilisé par le contrat `calendar` et l'outil Claude. */
export async function visibleItems(from: Date, to: Date): Promise<CalendarItem[]> {
  const [r, prefs] = await Promise.all([loadCalendar(from, to), getPrefs()]);
  const hidden = new Set(prefs.initialized ? prefs.hidden : defaultHidden(r.sources));
  return r.events.filter(e => !hidden.has(e.sourceKey)).sort((a, b) => a.start.getTime() - b.start.getTime()).map(toCalendarItem);
}
