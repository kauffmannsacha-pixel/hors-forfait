// Rappels (@rappel) : stockés dans repo.kv('reminders'), notification système quand l'app tourne.
import { repo, isTauri, uid } from '../db/store';
import { getPage, displayTitle } from '../db/pages';
import { openPage, toastAction } from '../ui/appState';

export interface Reminder { id: string; pageId: string | null; at: number; text: string; done: boolean; createdAt: number }
const KEY = 'reminders';

export async function listReminders(): Promise<Reminder[]> { return (await repo.kvGet<Reminder[]>(KEY)) ?? []; }
async function saveAll(list: Reminder[]) { await repo.kvSet(KEY, list); }

export async function addReminder(r: { pageId: string | null; at: number; text: string; id?: string }): Promise<Reminder> {
  const rem: Reminder = { id: r.id ?? uid(), pageId: r.pageId, at: r.at, text: r.text, done: false, createdAt: Date.now() };
  await saveAll([...(await listReminders()).filter(x => x.id !== rem.id), rem]);
  schedule();
  return rem;
}
export async function updateReminder(id: string, patch: Partial<Reminder>) {
  const list = await listReminders();
  await saveAll(list.map(r => (r.id === id ? { ...r, ...patch } : r)));
  schedule();
}
export async function getReminder(id: string) { return (await listReminders()).find(r => r.id === id); }

let timer: number | undefined;
let started = false;

/** Démarre la surveillance des rappels (idempotent). */
export function startReminders() {
  if (started) return;
  started = true;
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
}

function schedule() {
  if (!started) return;
  window.clearTimeout(timer);
  void listReminders().then(list => {
    const now = Date.now();
    const pending = list.filter(r => !r.done);
    if (pending.some(r => r.at <= now)) { void fireDue(); return; }
    const next = pending.reduce((m, r) => Math.min(m, r.at), Infinity);
    // réveil au plus tard chaque minute (veille, changement d'heure…)
    const delay = Number.isFinite(next) ? Math.min(Math.max(250, next - now), 60_000) : 60_000;
    timer = window.setTimeout(schedule, delay);
  });
}

async function fireDue() {
  const list = await listReminders();
  const now = Date.now();
  let changed = false;
  for (const r of list) {
    if (r.done || r.at > now) continue;
    r.done = true; changed = true;
    // Rappel supprimé du texte entre-temps → on ignore.
    if (r.pageId) {
      const page = getPage(r.pageId);
      if (!page || page.trashed || !JSON.stringify(page.content ?? '').includes(r.id)) continue;
    }
    await notify(r);
  }
  if (changed) await saveAll(list);
  schedule();
}

async function notify(r: Reminder) {
  const page = r.pageId ? getPage(r.pageId) : undefined;
  const title = page ? `Rappel — ${displayTitle(page)}` : 'Rappel Prisme';
  const body = r.text || (page ? displayTitle(page) : 'Rappel');
  try {
    if (isTauri) {
      const n = await import('@tauri-apps/plugin-notification');
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === 'granted';
      if (ok) n.sendNotification({ title, body });
    } else if ('Notification' in window) {
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body });
    }
  } catch { /* notification système indisponible : le toast suffit */ }
  toastAction(`⏰ ${body}`, page ? 'Ouvrir' : 'OK', () => { if (page) openPage(page.id); }, 'warning');
}

/** Demande l'autorisation de notifier (appelé à la création du premier rappel). */
export async function ensureNotificationPermission() {
  try {
    if (isTauri) {
      const n = await import('@tauri-apps/plugin-notification');
      if (!(await n.isPermissionGranted())) await n.requestPermission();
    } else if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch { /* ignoré */ }
}
