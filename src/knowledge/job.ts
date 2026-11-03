// Tâche en cours (mise à jour, import…) : progression détaillée, journal, annulation. Une seule tâche à la fois.
import { create } from 'zustand';

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';
export interface JobLog { at: number; level: LogLevel; text: string }
export interface JobState {
  running: boolean;
  kind: 'update' | 'import' | 'video' | null;
  label: string;
  phase: string;
  done: number;
  total: number;
  /** Sous-progression de l'élément courant (0-1). */
  sub: number;
  current?: string;
  quotaUsed: number;
  quotaBudget: number;
  added: number;
  duplicates: number;
  startedAt?: number;
  finishedAt?: number;
  log: JobLog[];
  controller: AbortController | null;
}

const idle: Omit<JobState, 'log'> = { running: false, kind: null, label: '', phase: '', done: 0, total: 0, sub: 0, quotaUsed: 0, quotaBudget: 0, added: 0, duplicates: 0, controller: null };
export const useKnJob = create<JobState>(() => ({ ...idle, log: [] }));

export interface JobHandle {
  signal: AbortSignal;
  log: (level: LogLevel, text: string) => void;
  phase: (phase: string, total?: number) => void;
  step: (done: number, current?: string) => void;
  sub: (fraction: number) => void;
  quota: (used: number, budget: number) => void;
  counts: (added: number, duplicates: number) => void;
}

export class JobBusyError extends Error { constructor() { super('Une tâche de la base de connaissances est déjà en cours.'); this.name = 'JobBusyError'; } }

/** Lance une tâche exclusive ; la fonction reçoit un handle de progression et un signal d'annulation. */
export async function runJob<T>(kind: NonNullable<JobState['kind']>, label: string, fn: (h: JobHandle) => Promise<T>): Promise<T> {
  if (useKnJob.getState().running) throw new JobBusyError();
  const controller = new AbortController();
  useKnJob.setState({ ...idle, running: true, kind, label, controller, startedAt: Date.now(), log: [] });
  const h: JobHandle = {
    signal: controller.signal,
    log: (level, text) => useKnJob.setState(s => ({ log: [...s.log.slice(-299), { at: Date.now(), level, text }] })),
    phase: (phase, total) => useKnJob.setState(s => ({ phase, total: total ?? s.total, done: total != null ? 0 : s.done, sub: 0, current: undefined })),
    step: (done, current) => useKnJob.setState({ done, current, sub: 0 }),
    sub: (fraction) => useKnJob.setState({ sub: Math.max(0, Math.min(1, fraction)) }),
    quota: (quotaUsed, quotaBudget) => useKnJob.setState({ quotaUsed, quotaBudget }),
    counts: (added, duplicates) => useKnJob.setState({ added, duplicates }),
  };
  try { return await fn(h); }
  finally { useKnJob.setState({ running: false, controller: null, finishedAt: Date.now(), current: undefined }); }
}

export const cancelJob = () => useKnJob.getState().controller?.abort();
