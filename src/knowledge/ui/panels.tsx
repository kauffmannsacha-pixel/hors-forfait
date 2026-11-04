// Onglets Sources, Créateurs et Index de la vue « Base de connaissances ».
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { confirmAction, toast } from '../../ui/appState';
import { Button, Empty, Input } from '../../ui/kit';
import { uid } from '../../db/store';
import { repo } from '../../db/store';
import { openSourceUrl } from '../api';
import { engine, useIndexState } from '../engine';
import { MODEL_SIZE_MB, useModel } from '../embed/client';
import { checkPrerequisites, providerLabel, runSingleVideo, type Prerequisites } from '../ingest/pipeline';
import { useKnJob } from '../job';
import { nextAutoUpdate } from '../scheduler';
import { DEFAULT_CREATORS, getSettings, KV, parseChannelInput, saveSettings, useKnSettings } from '../settings';
import type { KnSource, SeedVideo, UpdateReport } from '../types';
import { fmtAgo, fmtDate, fmtDuration, JobPanel, ProgressBar, SPRING, useEngine } from './parts';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STATUS: Record<KnSource['status'], { label: string; cls: string }> = {
  ok: { label: 'Analysée', cls: 'ok' }, empty: { label: 'Rien d\'actionnable', cls: 'warn' },
  'no-transcript': { label: 'Sans transcription', cls: 'warn' }, error: { label: 'Erreur', cls: 'bad' },
};

// ── Sources ──────────────────────────────────────────────────
export function SourcesPanel({ onImportTranscript }: { onImportTranscript: (videoId: string) => void }) {
  useEngine();
  const busy = useKnJob(s => s.running);
  const reduce = useReducedMotion();
  const [filter, setFilter] = useState<'all' | 'ok' | 'issues'>('all');
  const [queue, setQueue] = useState<SeedVideo[]>([]);
  const sources = engine.sources();
  useEffect(() => { void engine.seedQueue().then(setQueue).catch(() => undefined); }, []);
  const pending = queue.filter(v => !engine.source('yt:' + v.videoId));
  const shown = sources.filter(s => filter === 'all' || (filter === 'ok' ? s.status === 'ok' : s.status !== 'ok'));

  const retry = async (s: KnSource) => {
    if (!s.videoId) return;
    try {
      const r = await runSingleVideo({ videoId: s.videoId, title: s.title ?? s.videoId, creator: s.creator, channelId: s.channelId, channelTitle: s.channelTitle, durationSec: s.durationSec, views: s.views, publishedAt: s.publishedAt, priority: 0, origin: 'manual' }, { refresh: true });
      toast(r.status === 'ok' ? `${r.added} principe(s) ajouté(s).` : (r.detail ?? 'Aucun principe extrait.'), r.status === 'ok' ? 'success' : 'warning');
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const remove = async (s: KnSource) => {
    if (!(await confirmAction(`Supprimer la source « ${s.title ?? s.id} » et ses ${s.principles} principe(s) ?`, { danger: true, confirmLabel: 'Supprimer' }))) return;
    await engine.removeSource(s.id);
    toast('Source supprimée.', 'success');
  };

  return (
    <div>
      <div className="kn-seg" role="tablist" style={{ marginTop: 0, marginBottom: 14 }}>
        {([['all', 'Toutes', sources.length], ['ok', 'Analysées', sources.filter(s => s.status === 'ok').length], ['issues', 'À revoir', sources.filter(s => s.status !== 'ok').length]] as const).map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
            {filter === id && <motion.span layoutId="kn-src-pill" className="kn-seg-pill" transition={SPRING} />}<span>{label}</span><small>{n}</small>
          </button>
        ))}
      </div>
      {!shown.length && <Empty icon="🗂️" title="Aucune source pour l'instant">Lance « Mettre à jour les connaissances » ou importe un document.</Empty>}
      <div className="kn-list">
        <AnimatePresence initial={false}>
          {shown.map(s => (
            <motion.div key={s.id} className="glass kn-row" layout={!reduce} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, height: 0, marginTop: -8 }} transition={SPRING}>
              <div className="kn-avatar" aria-hidden>{s.kind === 'youtube' ? '▶' : '📄'}</div>
              <div className="kn-row-main">
                <div className="kn-row-title">{s.title ?? s.id}</div>
                <div className="kn-row-sub" title={s.detail}>
                  {s.creator}{s.channelTitle && s.channelTitle !== s.creator ? ` (chaîne ${s.channelTitle})` : ''} · {fmtAgo(s.updatedAt)}
                  {s.durationSec ? ` · ${fmtDuration(s.durationSec)}` : ''}{s.provider ? ` · ${providerLabel(s.provider)}` : ''} · {s.principles} principe(s){s.detail ? ` · ${s.detail}` : ''}
                </div>
              </div>
              <span className={`kn-status ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
              {(s.videoId || s.url) && <button className="kn-icon-btn" title="Ouvrir" aria-label="Ouvrir la source" onClick={() => void openSourceUrl({ kind: s.kind, creator: s.creator, videoId: s.videoId, url: s.url }).catch(e => toast(errMsg(e), 'error'))}>↗</button>}
              {s.videoId && s.status !== 'ok' && <button className="kn-icon-btn" title="Réessayer" aria-label="Réessayer l'analyse" disabled={busy} onClick={() => void retry(s)}>⟳</button>}
              {s.videoId && s.status !== 'ok' && <button className="kn-icon-btn" title="Importer la transcription à la main" aria-label="Importer la transcription" onClick={() => onImportTranscript(s.videoId!)}>⇪</button>}
              <button className="kn-icon-btn danger" title="Supprimer" aria-label="Supprimer la source" onClick={() => void remove(s)}>✕</button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {pending.length > 0 && <>
        <div className="kn-section">En file d'attente <small>{pending.length} vidéo(s) vérifiée(s), analysées en priorité à la prochaine mise à jour</small></div>
        <div className="kn-list">
          {pending.map(v => (
            <div key={v.videoId} className="glass kn-row">
              <div className="kn-avatar" aria-hidden>⏳</div>
              <div className="kn-row-main"><div className="kn-row-title">{v.title}</div><div className="kn-row-sub">{v.creator}{v.channelTitle && v.channelTitle !== v.creator ? ` (chaîne ${v.channelTitle})` : ''}{v.durationSec ? ` · ${fmtDuration(v.durationSec)}` : ''}</div></div>
              <button className="kn-icon-btn" title="Ouvrir" aria-label="Ouvrir la vidéo" onClick={() => void openSourceUrl({ kind: 'youtube', creator: v.creator, videoId: v.videoId }).catch(e => toast(errMsg(e), 'error'))}>↗</button>
              <button className="kn-icon-btn" title="Importer la transcription à la main" aria-label="Importer la transcription" onClick={() => onImportTranscript(v.videoId)}>⇪</button>
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

// ── Créateurs ────────────────────────────────────────────────
export function CreatorsPanel() {
  useEngine();
  const settings = useKnSettings(s => s.settings);
  const [input, setInput] = useState('');
  useEffect(() => { void getSettings(); }, []);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of engine.list()) { const k = p.source.creator.toLowerCase(); m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [engine.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!settings) return null;
  const countFor = (name: string) => { let n = 0; const k = name.toLowerCase(); for (const [c, v] of counts) if (c.startsWith(k)) n += v; return n; };
  const add = async () => {
    const parsed = parseChannelInput(input);
    const name = parsed.name ?? parsed.handle ?? parsed.channelId;
    if (!name) return;
    if (settings.creators.some(c => (parsed.channelId && c.channelId === parsed.channelId) || c.name.toLowerCase() === name.toLowerCase())) { toast('Ce créateur est déjà suivi.', 'warning'); return; }
    await saveSettings({ creators: [...settings.creators, { id: uid(), name: parsed.handle ? parsed.handle.slice(1) : name, handle: parsed.handle, channelId: parsed.channelId, enabled: true }] });
    setInput('');
    toast('Créateur ajouté : sa chaîne sera résolue à la prochaine mise à jour.', 'success');
  };
  const reset = async () => {
    if (!(await confirmAction('Remplacer la liste par les créateurs par défaut ?', { confirmLabel: 'Réinitialiser' }))) return;
    await saveSettings({ creators: DEFAULT_CREATORS.map(c => ({ ...c, id: uid() })) });
  };
  return (
    <div>
      <div className="kn-inline" style={{ marginBottom: 14, maxWidth: 680 }}>
        <Input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && void add()} placeholder="Nom, @handle, lien ou ID de chaîne (UC…)" aria-label="Ajouter un créateur" />
        <Button variant="primary" disabled={!input.trim()} onClick={add}>Suivre</Button>
        <Button variant="ghost" onClick={reset}>Liste par défaut</Button>
      </div>
      <div className="kn-list">
        {settings.creators.map(c => (
          <div key={c.id} className="glass kn-row" style={{ opacity: c.enabled ? 1 : 0.55 }}>
            <div className="kn-avatar">{c.thumbnail ? <img src={c.thumbnail} alt="" /> : c.name.slice(0, 1).toUpperCase()}</div>
            <div className="kn-row-main">
              <div className="kn-row-title">{c.name}</div>
              <div className="kn-row-sub">
                {c.channelId ? `Chaîne ${c.resolvedTitle ? `« ${c.resolvedTitle} » ` : ''}(${c.channelId})` : c.handle ? `${c.handle} — résolue à la prochaine mise à jour` : 'Recherchée par nom à la prochaine mise à jour'} · {countFor(c.name)} principe(s)
              </div>
            </div>
            <label className="kn-switch" style={{ border: 0, padding: 0 }} title={c.enabled ? 'Suivi actif' : 'Suivi en pause'}>
              <input type="checkbox" checked={c.enabled} aria-label={`Suivre ${c.name}`} onChange={e => void saveSettings({ creators: settings.creators.map(x => x.id === c.id ? { ...x, enabled: e.target.checked } : x) })} />
            </label>
            {c.channelId && <button className="kn-icon-btn" title="Ouvrir la chaîne" aria-label="Ouvrir la chaîne" onClick={() => void openSourceUrl({ kind: 'manual', creator: c.name, url: `https://www.youtube.com/channel/${c.channelId}` }).catch(e => toast(errMsg(e), 'error'))}>↗</button>}
            <button className="kn-icon-btn" title="Résoudre à nouveau" aria-label="Résoudre la chaîne à nouveau" onClick={() => void saveSettings({ creators: settings.creators.map(x => x.id === c.id ? { ...x, channelId: undefined, resolvedTitle: undefined } : x) })}>⟲</button>
            <button className="kn-icon-btn danger" title="Ne plus suivre" aria-label={`Ne plus suivre ${c.name}`} onClick={() => void saveSettings({ creators: settings.creators.filter(x => x.id !== c.id) })}>✕</button>
          </div>
        ))}
      </div>
      <p className="kn-hint" style={{ marginTop: 12 }}>Les vidéos récentes de ces chaînes qui parlent de création YouTube sont analysées à chaque mise à jour (les autres sont ignorées). La résolution d'un @handle coûte 1 unité de quota, une recherche par nom 100.</p>
    </div>
  );
}

// ── Index ────────────────────────────────────────────────────
export function IndexPanel() {
  useEngine();
  const model = useModel();
  const idx = useIndexState();
  const settings = useKnSettings(s => s.settings);
  const [pre, setPre] = useState<Prerequisites | null>(null);
  const [info, setInfo] = useState<{ last?: number; next?: number | null; check?: number; report?: UpdateReport; transcripts: number }>({ transcripts: 0 });
  const [working, setWorking] = useState(false);
  useEffect(() => {
    void checkPrerequisites().then(setPre).catch(() => undefined);
    void (async () => {
      const [last, next, check, report, transcripts] = await Promise.all([
        repo.kvGet<number>(KV.lastUpdate), nextAutoUpdate(), repo.kvGet<number>(KV.lastCheck), repo.kvGet<UpdateReport>(KV.lastReport), engine.transcriptCount().catch(() => 0),
      ]);
      setInfo({ last, next, check, report, transcripts });
    })().catch(() => undefined);
  }, [engine.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = engine.list().length, embedded = engine.embeddedCount();
  const coverage = total ? Math.round((embedded / total) * 100) : 0;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setWorking(true);
    try { await fn(); toast(ok, 'success'); } catch (e) { toast(errMsg(e), 'error'); } finally { setWorking(false); }
  };
  const store = engine.storageEngine;
  const statusText = model.status === 'ready' ? 'Modèle chargé' : model.status === 'loading' ? (model.total ? `Téléchargement ${Math.round(model.progress)} % (${(model.loaded / 1e6).toFixed(0)}/${(model.total / 1e6).toFixed(0)} Mo)` : 'Chargement du modèle…')
    : model.status === 'error' ? model.error ?? 'Erreur' : model.status === 'unsupported' ? 'Indisponible ici (pas de Web Worker)' : 'Non chargé';
  return (
    <div>
      <div className="kn-stats">
        <div className="glass kn-stat"><div className="kn-stat-v">{total}</div><div className="kn-stat-l">principes</div></div>
        <div className="glass kn-stat"><div className="kn-stat-v">{coverage} %</div><div className="kn-stat-l">indexés sémantiquement ({embedded})</div></div>
        <div className="glass kn-stat"><div className="kn-stat-v">{engine.sources().filter(s => s.status === 'ok').length}</div><div className="kn-stat-l">sources analysées</div></div>
        <div className="glass kn-stat"><div className="kn-stat-v">{info.transcripts}</div><div className="kn-stat-l">transcriptions en cache</div></div>
      </div>

      <div className="glass card" style={{ marginBottom: 14 }}>
        <div className="card-head"><div className="card-title">Recherche sémantique locale</div><span className="kn-hint">{store === 'sqlite' ? 'SQLite + FTS5 (BM25)' : store === 'indexeddb' ? 'IndexedDB + BM25 maison' : store === 'memory' ? 'Mémoire + BM25 maison' : '…'}</span></div>
        <p className="kn-hint" style={{ marginTop: 0 }}>Embeddings calculés sur cet ordinateur ({model.model}, ~{MODEL_SIZE_MB} Mo, téléchargé une fois puis gardé en cache). Recherche hybride : sens (cosinus) + mots-clés (BM25) ; tant que le modèle n'est pas chargé, la recherche se fait par mots-clés.</p>
        <div className="kn-job-row" style={{ marginBottom: 8 }}>
          <span><span className={`kn-dot ${model.status === 'ready' ? 'ok' : model.status === 'loading' ? 'busy' : model.status === 'error' ? 'bad' : ''}`} />{settings?.semantic === false ? 'Désactivée dans les réglages' : statusText}</span>
          <div className="row">
            {model.status !== 'ready' && settings?.semantic !== false && <Button size="sm" variant="primary" disabled={working || model.status === 'loading' || model.status === 'unsupported'} onClick={() => run(() => engine.ensureIndex({ download: true }).then(() => repo.kvSet(KV.modelReadyOnce, true)), 'Index sémantique prêt.')}>Télécharger le modèle et indexer</Button>}
            {model.status === 'ready' && embedded < total && <Button size="sm" disabled={working || idx.indexing} onClick={() => run(() => engine.ensureIndex({ download: true }), 'Embeddings calculés.')}>Indexer {total - embedded} principe(s)</Button>}
            {model.status === 'ready' && <Button size="sm" variant="ghost" disabled={working || idx.indexing} onClick={() => run(() => engine.rebuildIndex(), 'Index recalculé.')}>Tout recalculer</Button>}
          </div>
        </div>
        {model.status === 'loading' && <ProgressBar value={model.progress} indeterminate={!model.total} />}
        {idx.indexing && <><div className="kn-hint" style={{ margin: '8px 0 4px' }}>Indexation : {idx.done}/{idx.total}</div><ProgressBar value={idx.total ? (idx.done / idx.total) * 100 : 0} /></>}
        {idx.error && <div className="kn-hint" style={{ color: 'var(--bad)' }}>{idx.error}</div>}
      </div>

      <div className="glass card" style={{ marginBottom: 14 }}>
        <div className="card-head"><div className="card-title">Mises à jour</div></div>
        <div className="kn-job-meta" style={{ display: 'grid', gap: 4 }}>
          <span>Dernière mise à jour : <b>{fmtDate(info.last)}</b> ({fmtAgo(info.last)})</span>
          <span>Mise à jour automatique : <b>{settings?.autoUpdate ? (info.next ? (info.next <= Date.now() ? 'dès que les conditions sont réunies' : fmtDate(info.next)) : '—') : 'désactivée'}</b> · vérification au démarrage puis toutes les 6 h (dernière : {fmtAgo(info.check)})</span>
          {info.report && <span>Dernier bilan : {info.report.principles} principe(s) depuis {info.report.videos} vidéo(s), {info.report.noTranscript} sans transcription, {info.report.errors} erreur(s), {info.report.quotaUsed} unités de quota{info.report.cancelled ? ' — annulée' : ''}</span>}
        </div>
        {pre && <div className="kn-job-meta" style={{ marginTop: 10, display: 'grid', gap: 4 }}>
          <span><span className={`kn-dot ${pre.claude ? 'ok' : 'bad'}`} />Claude : {pre.claude ? 'clé API configurée' : 'clé API manquante (Réglages → Claude)'}</span>
          <span><span className={`kn-dot ${pre.youtube ? 'ok' : 'warn'}`} />YouTube : {pre.youtube ? 'chaîne connectée (recherche, sous-titres officiels de tes vidéos)' : 'aucune chaîne connectée (Réglages → Connexions)'}</span>
          <span><span className={`kn-dot ${pre.mcpTool ? 'ok' : 'warn'}`} />Transcriptions des autres créateurs : {pre.mcpTool ? `outil MCP ${pre.mcpTool}` : 'aucun outil MCP « transcript » détecté — import manuel possible'}</span>
        </div>}
      </div>
      <JobPanel showLog />
    </div>
  );
}
