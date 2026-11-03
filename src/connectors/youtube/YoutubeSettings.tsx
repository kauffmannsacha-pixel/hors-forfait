// Réglages YouTube : clé API (données publiques), quota du jour (buckets), limites, réserve, cache.
import { useEffect, useState } from 'react';
import { Button, Field, Input } from '../../ui/kit';
import { toast } from '../../ui/appState';
import type { QuotaBucket } from '../api';
import { sharedCache } from '../core/cache';
import { errorMessage } from '../core/errors';
import { formatDurationMs, formatInt } from '../core/format';
import { ExternalLink, Guide, InlineError, Meter, SecretInput } from '../core/ui';
import { getApiKey, setApiKey } from './client';
import { quotaSettings, quotaState, setQuotaSettings, useQuota } from './quotaStore';

export function YoutubeSettings() {
  const state = useQuota(s => s.state);
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const [limits, setLimits] = useState<Record<QuotaBucket, number> | null>(null);
  const [reserve, setReserve] = useState(500);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    void quotaState();
    void getApiKey().then(k => setHasKey(!!k));
    void quotaSettings().then(s => { setLimits(s.limits); setReserve(s.reserve); });
    const t = setInterval(() => void quotaState(), 60_000);
    return () => clearInterval(t);
  }, []);

  const saveKey = async () => {
    setBusy('key'); setErr('');
    try {
      const k = key.trim();
      if (!/^AIza[0-9A-Za-z_-]{35}$/.test(k)) throw new Error('Une clé API Google commence par « AIza » et compte 39 caractères.');
      await setApiKey(k); setHasKey(true); setKey('');
      toast('Clé API YouTube enregistrée.', 'success');
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(''); }
  };
  const removeKey = async () => { await setApiKey(null); setHasKey(false); toast('Clé API supprimée.', 'info'); };
  const saveLimits = async () => {
    if (!limits) return;
    setBusy('limits');
    try { await setQuotaSettings({ limits, reserve }); toast('Limites de quota enregistrées.', 'success'); } finally { setBusy(''); }
  };
  const clearCache = async () => {
    setBusy('cache');
    try { const n = await sharedCache().invalidate('yt:'); toast(`${n} réponse(s) YouTube retirée(s) du cache.`, 'success'); } finally { setBusy(''); }
  };

  return (
    <div className="cx-stack">
      <Guide title="Clé API et chaînes" steps={[
        <>La <b>clé API</b> sert aux données publiques (recherche, vidéos de n’importe quelle chaîne). Crée-la dans <ExternalLink href="https://console.cloud.google.com/apis/credentials">Identifiants</ExternalLink> du même projet que l’identifiant OAuth, puis restreins-la à « YouTube Data API v3 ».</>,
        <>Chaque <b>chaîne</b> se connecte séparément (bouton « Ajouter une chaîne ») : choisis le compte Google, puis la chaîne — y compris une <b>chaîne de marque</b>.</>,
        <>Accepte « rapports monétaires » pour voir les revenus (chaînes monétisées) et « gérer vos vidéos » pour publier depuis Prisme.</>,
      ]} />
      <div className="cx-subtitle">Clé API (données publiques)</div>
      {hasKey ? (
        <div className="cx-row-wrap"><span className="cx-chip on">✓ Clé enregistrée dans le coffre</span><Button size="sm" variant="ghost" onClick={() => void removeKey()}>Supprimer</Button></div>
      ) : (
        <form className="cx-row-wrap" onSubmit={e => { e.preventDefault(); void saveKey(); }}>
          <div style={{ flex: 1, minWidth: 240 }}><SecretInput value={key} onChange={setKey} placeholder="AIza…" /></div>
          <Button type="submit" size="sm" variant="primary" loading={busy === 'key'} disabled={!key.trim()}>Enregistrer</Button>
        </form>
      )}
      <InlineError>{err}</InlineError>

      <div className="cx-subtitle">Quota du jour <span className="cx-hint">— remise à zéro dans {state ? formatDurationMs(state.resetAt - Date.now()) : '…'} (minuit, heure du Pacifique)</span></div>
      {state?.buckets.map(b => (
        <Meter key={b.id} value={b.used} max={b.limit} label={b.label} detail={`${formatInt(b.used)} / ${formatInt(b.limit)} ${b.unit}`} />
      ))}
      {state && Object.keys(state.byMethod).length > 0 && (
        <div className="cx-hint">Détail : {Object.entries(state.byMethod).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${formatInt(v)}`).join(' · ')}</div>
      )}
      {limits && (
        <form className="cx-grid-3" onSubmit={e => { e.preventDefault(); void saveLimits(); }}>
          <Field label="Quota général (unités)" hint="10 000 par défaut ; augmente-le si Google t’a accordé plus.">
            <Input type="number" min={100} step={100} value={limits.default} onChange={e => setLimits({ ...limits, default: Number(e.target.value) || 0 })} />
          </Field>
          <Field label="Recherches / jour" hint="Bucket dédié de search.list (100 par défaut).">
            <Input type="number" min={1} value={limits.search} onChange={e => setLimits({ ...limits, search: Number(e.target.value) || 0 })} />
          </Field>
          <Field label="Réserve publication" hint="Unités gardées pour miniatures, mises à jour, sous-titres.">
            <Input type="number" min={0} step={50} value={reserve} onChange={e => setReserve(Number(e.target.value) || 0)} />
          </Field>
          <div className="cx-actions" style={{ gridColumn: '1 / -1' }}>
            <Button type="button" size="sm" variant="ghost" loading={busy === 'cache'} onClick={() => void clearCache()}>Vider le cache YouTube</Button>
            <Button type="submit" size="sm" variant="primary" loading={busy === 'limits'}>Enregistrer les limites</Button>
          </div>
        </form>
      )}
    </div>
  );
}
