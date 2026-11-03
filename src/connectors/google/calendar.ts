// Google Calendar API v3 : agendas, événements (lecture cache + écriture).
import { GOOGLE_SCOPES } from '../api';
import { sharedCache } from '../core/cache';
import { withRetry } from '../core/errors';
import { googleFetch, hasScopes, listGoogleAccounts } from './accounts';

const API = 'https://www.googleapis.com/calendar/v3';
export const CALENDAR_SCOPES = GOOGLE_SCOPES.calendar;

export interface GCalendar { id: string; accountId: string; summary: string; color: string; primary: boolean; writable: boolean; selected: boolean; timeZone?: string }
export interface GEventTime { date?: string; dateTime?: string; timeZone?: string }
export interface GEvent {
  id: string; calendarId: string; accountId: string; summary: string; description?: string; location?: string;
  start: GEventTime; end: GEventTime; htmlLink?: string; status?: string;
}
export interface GEventInput { summary: string; description?: string; location?: string; start: GEventTime; end: GEventTime }

interface RawCal { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; accessRole?: string; selected?: boolean; timeZone?: string; hidden?: boolean }
interface RawEvent { id: string; summary?: string; description?: string; location?: string; start?: GEventTime; end?: GEventTime; htmlLink?: string; status?: string }

const enc = encodeURIComponent;

/** Comptes Google ayant autorisé l'agenda. */
export async function calendarAccounts() {
  return (await listGoogleAccounts()).filter(a => hasScopes(a.scopes, CALENDAR_SCOPES));
}

export async function listCalendars(accountId: string, force = false, interactive = false): Promise<GCalendar[]> {
  const { value } = await sharedCache().wrap(`g:${accountId}:calendars`, 30 * 60_000, async () => {
    const out: GCalendar[] = []; let pageToken = '';
    do {
      const r = await withRetry(() => googleFetch(accountId, CALENDAR_SCOPES, `${API}/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${enc(pageToken)}` : ''}`, {}, 'Google Agenda', interactive));
      const j = await r.json() as { items?: RawCal[]; nextPageToken?: string };
      for (const c of j.items ?? []) {
        if (c.hidden) continue;
        out.push({
          id: c.id, accountId, summary: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#0a84ff',
          primary: !!c.primary, writable: c.accessRole === 'owner' || c.accessRole === 'writer', selected: c.selected !== false || !!c.primary, timeZone: c.timeZone,
        });
      }
      pageToken = j.nextPageToken ?? '';
    } while (pageToken);
    return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary, 'fr'));
  }, { force });
  return value;
}

/** Événements (récurrences dépliées) entre deux dates — cache 5 min, lecture hors-ligne. */
export async function listEvents(accountId: string, calendarId: string, from: Date, to: Date, force = false, interactive = false): Promise<{ events: GEvent[]; stale: boolean }> {
  const key = `g:${accountId}:events:${calendarId}:${from.toISOString().slice(0, 13)}:${to.toISOString().slice(0, 13)}`;
  const { value, stale } = await sharedCache().wrap(key, 5 * 60_000, async () => {
    const out: GEvent[] = []; let pageToken = '';
    do {
      const qs = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
      if (pageToken) qs.set('pageToken', pageToken);
      const r = await withRetry(() => googleFetch(accountId, CALENDAR_SCOPES, `${API}/calendars/${enc(calendarId)}/events?${qs}`, {}, 'Google Agenda', interactive));
      const j = await r.json() as { items?: RawEvent[]; nextPageToken?: string };
      for (const e of j.items ?? []) {
        if (e.status === 'cancelled' || !e.start || !e.end) continue;
        out.push({ id: e.id, calendarId, accountId, summary: e.summary || '(Sans titre)', description: e.description, location: e.location, start: e.start, end: e.end, htmlLink: e.htmlLink, status: e.status });
      }
      pageToken = j.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }, { force });
  return { events: value, stale };
}

async function invalidateEvents(accountId: string) { await sharedCache().invalidate(`g:${accountId}:events:`); }

export async function insertEvent(accountId: string, calendarId: string, ev: GEventInput): Promise<GEvent> {
  const r = await googleFetch(accountId, CALENDAR_SCOPES, `${API}/calendars/${enc(calendarId)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) }, 'Google Agenda');
  const e = await r.json() as RawEvent;
  await invalidateEvents(accountId);
  return { id: e.id, calendarId, accountId, summary: e.summary ?? ev.summary, description: e.description, location: e.location, start: e.start ?? ev.start, end: e.end ?? ev.end, htmlLink: e.htmlLink };
}

export async function patchEvent(accountId: string, calendarId: string, eventId: string, patch: Partial<GEventInput>): Promise<void> {
  await googleFetch(accountId, CALENDAR_SCOPES, `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }, 'Google Agenda');
  await invalidateEvents(accountId);
}

/** Déplace un événement vers un autre agenda (même compte). */
export async function moveEvent(accountId: string, calendarId: string, eventId: string, destination: string): Promise<void> {
  await googleFetch(accountId, CALENDAR_SCOPES, `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}/move?destination=${enc(destination)}`, { method: 'POST' }, 'Google Agenda');
  await invalidateEvents(accountId);
}

export async function deleteEvent(accountId: string, calendarId: string, eventId: string): Promise<void> {
  await googleFetch(accountId, CALENDAR_SCOPES, `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'DELETE' }, 'Google Agenda');
  await invalidateEvents(accountId);
}
