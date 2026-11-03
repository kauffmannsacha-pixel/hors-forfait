// Imports en cours (affichés dans le HUD de progression) + exécution avec parallélisme limité.
import { create } from 'zustand';
import type { VaultFile } from '../db/types';
import { toast } from '../ui/appState';
import { errMsg, type Progress } from './backend';
import { plural } from './kinds';

export interface ImportJob { id: string; name: string; done: number; total: number; status: 'running' | 'done' | 'error'; startedAt: number }
export const useImportJobs = create<{ jobs: ImportJob[] }>(() => ({ jobs: [] }));

const patch = (id: string, p: Partial<ImportJob>) => useImportJobs.setState(s => ({ jobs: s.jobs.map(j => (j.id === id ? { ...j, ...p } : j)) }));
const drop = (id: string, delay: number) => setTimeout(() => useImportJobs.setState(s => ({ jobs: s.jobs.filter(j => j.id !== id) })), delay);

/** Suivi d'un import dans le HUD. */
export function trackJob(name: string) {
  const id = crypto.randomUUID();
  useImportJobs.setState(s => ({ jobs: [...s.jobs, { id, name, done: 0, total: 0, status: 'running', startedAt: Date.now() }] }));
  let last = 0;
  return {
    progress: ((done, total) => {
      const now = performance.now();
      if (now - last < 80 && done < total) return; // limite les rendus
      last = now; patch(id, { done, total });
    }) as Progress,
    finish() { patch(id, { status: 'done' }); drop(id, 900); },
    fail() { patch(id, { status: 'error' }); drop(id, 2500); },
  };
}

/** Exécute `fn` sur chaque élément avec au plus `limit` tâches simultanées. */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Un import à effectuer (chemin, File, octets…) — `run` reçoit le rappel de progression. */
export interface PinJob { name: string; run: (onProgress: Progress) => Promise<VaultFile> }

/** Lance un job suivi dans le HUD ; renvoie le fichier ou l'erreur (déjà signalée par un toast). */
export async function runJob(job: PinJob, onProgress?: Progress): Promise<VaultFile | Error> {
  const t = trackJob(job.name);
  try {
    const f = await job.run((d, total) => { t.progress(d, total); onProgress?.(d, total); });
    t.finish();
    return f;
  } catch (e) {
    t.fail();
    toast(`Import impossible : « ${job.name} » — ${errMsg(e)}`, 'error');
    return e instanceof Error ? e : new Error(errMsg(e));
  }
}

/** Ajoute des fichiers au vault sans les épingler (dépôt hors d'une page, vue Fichiers). */
export async function importJobs(jobs: PinJob[]): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  await runLimited(jobs, 3, async job => { const r = await runJob(job); if (!(r instanceof Error)) out.push(r); });
  if (out.length) toast(`${plural(out.length, 'fichier ajouté', 'fichiers ajoutés')} au vault.`, 'success');
  return out;
}
