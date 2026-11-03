// Mise à jour automatique hebdomadaire : vérification au démarrage puis toutes les 6 h.
import { repo } from '../db/store';
import { toast } from '../ui/appState';
import { engine } from './engine';
import { useKnJob } from './job';
import { checkPrerequisites, runUpdate } from './ingest/pipeline';
import { getSettings, KV } from './settings';

export const WEEK_MS = 7 * 24 * 3600e3;
export const CHECK_EVERY_MS = 6 * 3600e3;
/** Délai minimal entre deux tentatives automatiques échouées (préserve le quota). */
export const RETRY_FAILED_MS = 24 * 3600e3;

/** Décision pure (testée) : faut-il lancer la mise à jour automatique maintenant ? */
export function isUpdateDue(now: number, lastUpdate: number | undefined, lastAttempt: number | undefined): boolean {
  if (lastUpdate != null && now - lastUpdate < WEEK_MS) return false;
  if (lastAttempt != null && (lastUpdate == null || lastAttempt > lastUpdate) && now - lastAttempt < RETRY_FAILED_MS) return false;
  return true;
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export async function autoCheck(): Promise<void> {
  await repo.kvSet(KV.lastCheck, Date.now()).catch(() => undefined);
  const s = await getSettings();
  if (!s.autoUpdate || useKnJob.getState().running) return;
  const [last, attempt] = await Promise.all([repo.kvGet<number>(KV.lastUpdate), repo.kvGet<number>(KV.lastAttempt)]);
  if (!isUpdateDue(Date.now(), last, attempt)) return;
  const pre = await checkPrerequisites();
  if (!pre.ok) return;
  try {
    const r = await runUpdate({ auto: true });
    if (!r.cancelled && r.principles > 0) toast(`Base de connaissances mise à jour : ${r.principles} nouveau(x) principe(s).`, 'success');
  } catch { /* le journal de la vue garde le détail */ }
}

/** Démarre le planificateur (idempotent). Le premier contrôle attend que l'app ait fini de démarrer. */
export function startScheduler(firstDelayMs = 45_000) {
  if (started) return;
  started = true;
  setTimeout(() => { void autoCheck(); }, firstDelayMs);
  timer = setInterval(() => { void autoCheck(); }, CHECK_EVERY_MS);
}

export const stopScheduler = () => { if (timer) clearInterval(timer); timer = null; started = false; };

/** Prochaine échéance (affichage). */
export async function nextAutoUpdate(): Promise<number | null> {
  const s = await getSettings();
  if (!s.autoUpdate) return null;
  const last = await repo.kvGet<number>(KV.lastUpdate);
  return last == null ? Date.now() : last + WEEK_MS;
}

/** Au premier lancement : charge le pré-remplissage puis calcule ses embeddings en arrière-plan. */
export async function bootKnowledge() {
  await engine.init();
  const s = await getSettings();
  if (!s.semantic) return;
  const once = await repo.kvGet<boolean>(KV.modelReadyOnce);
  // Premier lancement : téléchargement du modèle (~118 Mo) puis embeddings du pré-remplissage ; ensuite : simple chargement depuis le cache.
  await engine.ensureIndex({ download: !once }).catch(() => undefined);
  if (once) await engine.warmup();
}
