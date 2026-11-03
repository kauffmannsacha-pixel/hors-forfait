// Suivi persistant du quota YouTube (kv `youtube:quota`), limites réglables, remise à zéro à minuit (Pacifique).
import { create } from 'zustand';
import { repo } from '../../db/store';
import type { QuotaBucket, QuotaState } from '../api';
import { canSpend, charge, DEFAULT_LIMITS, ledgerFor, nextPacificMidnight, pacificDayKey, QUOTA_BUCKETS, quotaCost, type QuotaLedger } from '../core/quota';
import { ConnectorError } from '../core/errors';
import { formatDurationMs, formatInt } from '../core/format';

const LEDGER_KV = 'youtube:quota';
const SETTINGS_KV = 'youtube:quota:settings';
export interface QuotaSettings { limits: Record<QuotaBucket, number>; reserve: number }
const DEFAULT_SETTINGS: QuotaSettings = { limits: { ...DEFAULT_LIMITS }, reserve: 500 };

let ledger: QuotaLedger | null = null;
let settings: QuotaSettings | null = null;
let loading: Promise<void> | null = null;
let chain: Promise<void> = Promise.resolve();

/** État observable pour l'interface (jauges). */
export const useQuota = create<{ state: QuotaState | null }>(() => ({ state: null }));

async function load() {
  loading ??= (async () => {
    ledger = (await repo.kvGet<QuotaLedger>(LEDGER_KV).catch(() => undefined)) ?? null;
    const s = await repo.kvGet<Partial<QuotaSettings>>(SETTINGS_KV).catch(() => undefined);
    settings = { limits: { ...DEFAULT_LIMITS, ...(s?.limits ?? {}) }, reserve: s?.reserve ?? DEFAULT_SETTINGS.reserve };
  })();
  await loading;
}

function snapshot(): QuotaState {
  const day = pacificDayKey();
  const l = ledgerFor(ledger, day);
  const s = settings ?? DEFAULT_SETTINGS;
  return {
    day, resetAt: nextPacificMidnight().getTime(), reserve: s.reserve, byMethod: l.byMethod,
    buckets: QUOTA_BUCKETS.map(b => ({ ...b, used: l.used[b.id], limit: s.limits[b.id] })),
  };
}

function persist() {
  const l = ledger;
  chain = chain.then(() => repo.kvSet(LEDGER_KV, l)).catch(() => undefined);
  useQuota.setState({ state: snapshot() });
}

export async function quotaState(): Promise<QuotaState> { await load(); const s = snapshot(); useQuota.setState({ state: s }); return s; }
export async function quotaSettings(): Promise<QuotaSettings> { await load(); return settings ?? DEFAULT_SETTINGS; }
export async function setQuotaSettings(s: QuotaSettings) {
  await load();
  settings = { limits: { ...DEFAULT_LIMITS, ...s.limits }, reserve: Math.max(0, Math.round(s.reserve)) };
  await repo.kvSet(SETTINGS_KV, settings);
  useQuota.setState({ state: snapshot() });
}

const untilReset = () => formatDurationMs(nextPacificMidnight().getTime() - Date.now());

/** Vérifie qu'un appel est possible ; sinon erreur lisible (quel quota, quand il revient). */
export async function quotaCheck(key: string): Promise<void> {
  await load();
  const s = settings ?? DEFAULT_SETTINGS;
  const r = canSpend(ledger, pacificDayKey(), key, s.limits, s.reserve);
  if (r.ok) return;
  const b = QUOTA_BUCKETS.find(x => x.id === r.bucket)!;
  const reserveNote = r.bucket === 'default' && r.remaining + r.cost > 0 && s.reserve > 0 ? ` (les ${formatInt(s.reserve)} dernières unités sont réservées à la publication)` : '';
  throw new ConnectorError(`Quota YouTube atteint — ${b.label} : ${key} coûte ${r.cost} ${b.unit}${reserveNote}. Remise à zéro à minuit, heure du Pacifique (dans ${untilReset()}).`, { service: 'YouTube', code: 'quota' });
}

/** Enregistre un appel (toute requête reçue par Google est facturée, même en erreur). */
export async function quotaRecord(key: string, calls = 1): Promise<void> {
  await load();
  ledger = charge(ledger, pacificDayKey(), key, calls);
  persist();
}

/** Google signale « quotaExceeded » : on considère le bucket épuisé jusqu'à minuit (Pacifique). */
export async function markExhausted(key: string) {
  await load();
  const day = pacificDayKey();
  const l = ledgerFor(ledger, day);
  const { bucket } = quotaCost(key);
  l.used[bucket] = Math.max(l.used[bucket], (settings ?? DEFAULT_SETTINGS).limits[bucket]);
  ledger = l;
  persist();
}

export async function quotaUsedToday(): Promise<number> { await load(); return ledgerFor(ledger, pacificDayKey()).used.default; }

export const quotaExceededMessage = (key: string) => {
  const b = QUOTA_BUCKETS.find(x => x.id === quotaCost(key).bucket)!;
  return `Quota YouTube épuisé pour aujourd’hui (${b.label}) — remise à zéro à minuit, heure du Pacifique (dans ${untilReset()}).`;
};
