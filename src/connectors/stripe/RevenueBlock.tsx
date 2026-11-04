// Bloc TipTap « Revenus » : MRR, ventes du jour, abonnés actifs, graphique 30 jours (recharts), actualisation.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { useReducedMotion } from 'motion/react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Spinner } from '../../ui/kit';
import { navigate } from '../../ui/appState';
import type { RevenueSnapshot } from '../api';
import { errorMessage } from '../core/errors';
import { timeAgo } from '../core/format';
import { getStripeKey } from './client';
import { formatMoney, toMajor } from './metrics';
import { loadRevenue } from './revenue';
import '../connectors.css';

const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="cx-kpi">
      <div className="cx-kpi-label">{label}</div>
      <div className="cx-kpi-value">{value}</div>
      {hint && <div className="cx-kpi-hint">{hint}</div>}
    </div>
  );
}

export function RevenueBlockView() {
  const [data, setData] = useState<RevenueSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [table, setTable] = useState(false);
  const reduce = useReducedMotion();
  const gradId = `cx-rev-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  const load = useCallback(async (force = false) => {
    setLoading(true); setError('');
    try {
      const has = !!(await getStripeKey());
      setConnected(has);
      if (!has) return;
      const r = await loadRevenue(force);
      setData(r.data); setStale(r.stale);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const cur = data?.currency ?? 'eur';
  const points = useMemo(() => (data?.series ?? []).map(d => ({ ...d, major: toMajor(d.amount, cur) })), [data, cur]);
  const axisMoney = useMemo(() => {
    try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 }); }
    catch { return new Intl.NumberFormat('fr-FR', { notation: 'compact' }); }
  }, [cur]);
  const avg = data ? data.total30 / 30 : 0;

  return (
    <NodeViewWrapper className="cx-revenue glass" contentEditable={false} data-drag-handle="">
      <div className="cx-revenue-head">
        <div>
          <div className="cx-revenue-title">Revenus</div>
          <div className="cx-hint">
            Stripe{data && !data.livemode ? ' · mode test' : ''}{data ? ` · actualisé ${timeAgo(data.at)}` : ''}{stale ? ' · hors ligne (dernières données connues)' : ''}
          </div>
        </div>
        <div className="cx-row">
          {data && <Button size="sm" variant="ghost" onClick={() => setTable(t => !t)} aria-pressed={table}>{table ? 'Graphique' : 'Tableau'}</Button>}
          {connected !== false && <Button size="sm" variant="ghost" loading={loading} onClick={() => void load(true)} aria-label="Actualiser les revenus">↻ Actualiser</Button>}
        </div>
      </div>

      {connected === false ? (
        <div className="cx-revenue-empty">
          <span>Connecte Stripe (clé restreinte en lecture) pour afficher MRR, ventes et abonnés.</span>
          <Button size="sm" variant="primary" onClick={() => navigate({ type: 'settings', panel: 'connexions' })}>Connecter Stripe</Button>
        </div>
      ) : !data ? (
        <div className="cx-revenue-empty">{error ? <span className="cx-inline-error">{error}</span> : <Spinner />}</div>
      ) : (
        <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .2s' }}>
          <div className="cx-kpis">
            <Kpi label="MRR" value={data.mrr == null ? '—' : formatMoney(data.mrr, cur)} hint={data.mrr == null ? 'permission Abonnements manquante' : 'abonnements actifs'} />
            <Kpi label="Ventes du jour" value={formatMoney(data.today.amount, cur)} hint={`${data.today.count} paiement${data.today.count > 1 ? 's' : ''} · moy. 30 j ${formatMoney(Math.round(avg), cur)}`} />
            <Kpi label="Abonnés actifs" value={data.activeSubscribers == null ? '—' : data.activeSubscribers.toLocaleString('fr-FR')} hint="clients distincts" />
          </div>
          {table ? (
            <div className="cx-revenue-table">
              <table>
                <thead><tr><th>Jour</th><th>Ventes nettes</th><th>Paiements</th></tr></thead>
                <tbody>{[...data.series].reverse().map(d => <tr key={d.date}><td>{dayLabel(d.date)}</td><td>{formatMoney(d.amount, cur)}</td><td>{d.count}</td></tr>)}</tbody>
              </table>
            </div>
          ) : (
            <div className="cx-revenue-chart" role="img" aria-label={`Ventes nettes des 30 derniers jours : ${formatMoney(data.total30, cur)} au total`}>
              <ResponsiveContainer width="100%" height={190}>
                <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.16} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--line)" />
                  <XAxis dataKey="date" tickFormatter={dayLabel} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tickFormatter={(v: number) => axisMoney.format(v)} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
                  <Tooltip
                    cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
                    content={({ active, payload }) => {
                      const p = active && payload?.[0] ? (payload[0].payload as { date: string; amount: number; count: number }) : null;
                      return p ? (
                        <div className="cx-tooltip glass">
                          <div className="cx-tooltip-value">{formatMoney(p.amount, cur)}</div>
                          <div className="cx-hint">{dayLabel(p.date)} · {p.count} paiement{p.count > 1 ? 's' : ''}</div>
                        </div>
                      ) : null;
                    }}
                  />
                  <Area type="monotone" dataKey="major" stroke="var(--accent)" strokeWidth={2} fill={`url(#${gradId})`} dot={false}
                    activeDot={{ r: 4, fill: 'var(--accent)', stroke: 'var(--bg2)', strokeWidth: 2 }} isAnimationActive={!reduce} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="cx-revenue-foot cx-hint">
            30 jours : <b>{formatMoney(data.total30, cur)}</b>
            {data.warnings.map(w => <span key={w}> · {w}</span>)}
            {error && <span className="cx-inline-error"> · {error}</span>}
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}
