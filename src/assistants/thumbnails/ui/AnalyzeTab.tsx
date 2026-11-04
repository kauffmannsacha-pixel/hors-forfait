// Onglet 1 — Analyse des miniatures des plus grosses vidéos d'une niche ou d'une chaîne.
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Button, Card, Empty, Field, Input, Select } from '../../../ui/kit';
import { toast } from '../../../ui/appState';
import { youtube } from '../../../connectors/api';
import { useThumbs, type ItemStatus } from '../state';
import { ytThumbUrl } from '../lib/browserImage';
import { formatDuration, formatViews, ratioLabel } from '../lib/format';
import { cancelAnalysis, runAnalysis } from '../lib/pipeline';
import type { ThumbRecord } from '../lib/types';
import type { Period } from '../lib/youtube';
import { Check, errText, Seg, Swatches } from './common';
import { NicheInsightsCard } from './Insights';
import { ThumbDetail } from './ThumbDetail';

const STATUS: Record<ItemStatus, { label: string; cls: string }> = {
  attente: { label: 'En attente', cls: '' }, image: { label: 'Téléchargement', cls: 'run' }, mesures: { label: 'Mesures', cls: 'run' },
  vision: { label: 'Claude Vision', cls: 'run' }, ok: { label: 'Analysée', cls: 'ok' }, cache: { label: 'En cache', cls: 'cache' }, erreur: { label: 'Erreur', cls: 'erreur' },
};

export function ThumbCard({ rec, status, onOpen, starred }: { rec: ThumbRecord; status?: ItemStatus; onOpen: () => void; starred?: boolean }) {
  const v = rec.vision, m = rec.metrics;
  return <div className="glass th-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}>
    <div className="th-thumb">
      <img src={ytThumbUrl(rec.videoId, 'mqdefault')} alt="" loading="lazy" />
      <span className="th-dur">{formatDuration(rec.durationSec)}</span>
      {rec.ratio != null && <span className="th-badge">{ratioLabel(rec.ratio)} abonnés</span>}
      {starred && <span className="th-badge th-ref-on" style={{ left: 'auto', right: 6, top: 6 }}>★</span>}
    </div>
    <div className="th-title">{rec.title}</div>
    <div className="th-meta"><span>{rec.channelTitle}</span>·<span>{formatViews(rec.views)}</span></div>
    <div className="th-chips">
      {status && <span className={`th-status ${STATUS[status].cls}`} title={rec.visionError ?? rec.metricsError}><i />{STATUS[status].label}</span>}
      {v && <span className="chip">{v.face ? v.emotion : 'sans visage'}</span>}
      {v && <span className="chip">{v.hasText ? `${v.wordCount} mot${v.wordCount > 1 ? 's' : ''}` : 'sans texte'}</span>}
      {m && <span className="chip" title="Lisibilité en 168×94">👁 {m.scores.legibility.toFixed(1).replace('.', ',')}</span>}
      {m && <Swatches palette={m.palette} max={4} />}
    </div>
  </div>;
}

export function AnalyzeTab() {
  const job = useThumbs(s => s.job);
  const library = useThumbs(s => s.library);
  const refs = useThumbs(s => s.refs);
  const [mode, setMode] = useState<'niche' | 'chaine'>('niche');
  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [max, setMax] = useState(24);
  const [period, setPeriod] = useState<Period>('12m');
  const [lang, setLang] = useState<'' | 'fr' | 'en'>('fr');
  const [excludeShorts, setExcludeShorts] = useState(true);
  const [vision, setVision] = useState(true);
  const [fast, setFast] = useState(false);
  const [reanalyze, setReanalyze] = useState(false);
  const [quota, setQuota] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const running = job?.status === 'en cours';

  useEffect(() => {
    let alive = true;
    youtube.quota().then(q => {
      const b = q.buckets.find(x => x.id === 'search'), d = q.buckets.find(x => x.id === 'default');
      if (alive) setQuota([b && `Recherches : ${b.used}/${b.limit}`, d && `quota général : ${d.used}/${d.limit}`].filter(Boolean).join(' · '));
    }).catch(() => youtube.quotaUsedToday().then(u => alive && setQuota(`Quota YouTube utilisé aujourd'hui : ${u} unités`)).catch(() => undefined));
    return () => { alive = false; };
  }, [job?.status]);

  const start = () => {
    if (!query.trim()) { toast(mode === 'niche' ? 'Indique une niche (ex. « minecraft survie »).' : 'Indique une chaîne (URL, @pseudo…).', 'warning'); return; }
    runAnalysis({ mode, query, label, max, excludeShorts, lang, period: mode === 'chaine' ? 'tout' : period, vision, fast, reanalyze })
      .then(() => { const j = useThumbs.getState().job; if (j?.status === 'terminé') toast(`Analyse terminée : ${j.items.length} miniatures.`, 'success'); else if (j?.status === 'erreur') toast(j.error ?? 'Échec de l\'analyse.', 'error'); })
      .catch(e => toast(errText(e), 'error'));
  };
  const done = job ? job.items.filter(i => i.status === 'ok' || i.status === 'cache' || i.status === 'erreur').length : 0;
  const progress = job?.items.length ? done / job.items.length : 0;

  return <div className="th-split">
    <div className="th-col th-sticky">
      <Card title="Analyser les miniatures qui cartonnent">
        <div style={{ marginBottom: 10 }}><Seg value={mode} onChange={setMode} label="Source" options={[{ id: 'niche', label: 'Niche' }, { id: 'chaine', label: 'Chaîne' }]} /></div>
        <Field label={mode === 'niche' ? 'Niche (recherche)' : 'Chaîne'} hint={mode === 'niche' ? 'Vidéos les plus vues pour cette recherche (API YouTube officielle).' : 'URL, @pseudo ou identifiant UC… — vidéos les plus vues de la chaîne.'}>
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder={mode === 'niche' ? 'ex. minecraft survie' : 'ex. @MrBeast'} onKeyDown={e => e.key === 'Enter' && !running && start()} />
        </Field>
        <Field label="Étiquette de niche (facultatif)" hint="Regroupe plusieurs recherches ou chaînes sous une même niche du mur.">
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={mode === 'niche' ? 'par défaut : la recherche' : 'par défaut : le nom de la chaîne'} />
        </Field>
        <div className="th-row" style={{ alignItems: 'flex-end' }}>
          <Field label="Vidéos"><Select value={max} onChange={e => setMax(Number(e.target.value))}>{[12, 24, 36, 50].map(n => <option key={n} value={n}>{n}</option>)}</Select></Field>
          {mode === 'niche' && <Field label="Période"><Select value={period} onChange={e => setPeriod(e.target.value as Period)}><option value="3m">3 derniers mois</option><option value="12m">12 derniers mois</option><option value="tout">Depuis toujours</option></Select></Field>}
          {mode === 'niche' && <Field label="Langue"><Select value={lang} onChange={e => setLang(e.target.value as '' | 'fr' | 'en')}><option value="fr">Français</option><option value="en">Anglais</option><option value="">Toutes</option></Select></Field>}
        </div>
        <Check checked={excludeShorts} onChange={setExcludeShorts} label="Exclure les Shorts (≤ 60 s)" />
        <Check checked={vision} onChange={setVision} label="Analyse Claude Vision (visage, émotion, texte, composition)" />
        <Check checked={fast} onChange={setFast} disabled={!vision} label="Mode économique (modèle rapide)" />
        <Check checked={reanalyze} onChange={setReanalyze} label="Ré-analyser les miniatures déjà en cache" />
        <div className="th-row" style={{ marginTop: 10 }}>
          {running ? <Button variant="danger" onClick={cancelAnalysis}>Arrêter</Button> : <Button variant="primary" onClick={start}>Analyser</Button>}
        </div>
        {quota && <div className="th-tiny th-muted" style={{ marginTop: 8 }}>{quota}</div>}
        <div className="th-tiny th-muted" style={{ marginTop: 6 }}>Les mesures (couleurs, contraste, netteté, saillance, lisibilité 168×94) sont calculées localement ; seules les images envoyées à Claude Vision quittent l'ordinateur.</div>
      </Card>
    </div>
    <div className="th-col">
      {!job && <Card><Empty icon="🔎" title="Aucune analyse en cours">Choisis une niche ou une chaîne : Prisme récupère les miniatures des vidéos les plus vues, les mesure et demande à Claude pourquoi elles marchent. Tout est gardé en cache pour le mur d'inspiration.</Empty></Card>}
      {job && <Card title={<span>{job.label || job.niche} <span className="th-muted th-small">· {job.status}</span></span>}>
        <div className="th-small th-muted" style={{ marginBottom: 6 }}>{job.step}{job.items.length ? ` — ${done}/${job.items.length}` : ''}</div>
        <div className="th-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><div style={{ width: `${(job.status === 'en cours' ? Math.max(0.04, progress) : progress) * 100}%` }} /></div>
        {job.error && <div className="th-error" style={{ marginTop: 8 }}>{job.error}</div>}
        {job.warnings.map(w => <div key={w} className="th-note" style={{ marginTop: 8 }}>{w}</div>)}
      </Card>}
      {job && job.items.length > 0 && <div className="th-wall">
        {job.items.map(it => { const rec = library[it.videoId]; return rec
          ? <motion.div key={it.videoId} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.4 }}>
            <ThumbCard rec={rec} status={it.status} starred={refs.some(r => r.videoId === it.videoId)} onOpen={() => setOpen(it.videoId)} />
          </motion.div>
          : <div key={it.videoId} className="glass th-card"><div className="th-thumb th-skel" /></div>; })}
      </div>}
      {job?.niche && job.status !== 'en cours' && <NicheInsightsCard niche={job.niche} />}
    </div>
    <ThumbDetail videoId={open} onClose={() => setOpen(null)} />
  </div>;
}
