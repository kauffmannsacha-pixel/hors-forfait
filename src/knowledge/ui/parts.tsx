// Briques d'interface partagées par la vue et les réglages.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { confirmAction, toast } from '../../ui/appState';
import { Button } from '../../ui/kit';
import { fmtTime, formatCitation, openSourceUrl, TOPIC_LABELS, type Principle, type Topic } from '../api';
import { engine } from '../engine';
import { cancelJob, useKnJob } from '../job';

export const TOPIC_COLORS: Record<Topic, string> = {
  script: '#5e5ce6', retention: '#30b0c7', hook: '#ff9f0a', thumbnail: '#ff375f',
  title: '#34c759', packaging: '#bf5af2', analytics: '#0a84ff', general: '#8e8e93',
};
export const KIND_LABELS = { youtube: 'Vidéo', document: 'Document', manual: 'Méthode', 'ab-test': 'Test A/B' } as const;

/** Réabonne le composant aux changements du moteur et lance son initialisation. */
export function useEngine() {
  const v = useSyncExternalStore(engine.subscribe, engine.getVersion);
  useEffect(() => { void engine.init().catch(() => undefined); }, []);
  return v;
}

export const SPRING = { type: 'spring' as const, bounce: 0, duration: 0.42 };

export function TopicChip({ topic }: { topic: Topic }) {
  return <span className="kn-topic" style={{ ['--tc' as string]: TOPIC_COLORS[topic] }}>{TOPIC_LABELS[topic]}</span>;
}

export function ProgressBar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return <div className={`kn-progress${indeterminate ? ' indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(value)}>
    <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </div>;
}

export const fmtDate = (t?: number | null) => t ? new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export function fmtAgo(t?: number | null): string {
  if (!t) return 'jamais';
  const d = Date.now() - t, m = Math.round(d / 60000);
  if (Math.abs(m) < 1) return 'à l\'instant';
  if (d < 0) { const h = Math.round(-d / 3600e3); return h < 24 ? `dans ${h} h` : `dans ${Math.round(h / 24)} j`; }
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60); if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
export const fmtDuration = (s?: number) => s ? (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)} min`) : '';

export async function openSource(p: Principle) {
  try { await openSourceUrl(p.source); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
}

export function PrincipleCard({ p, index = 0, score }: { p: Principle; index?: number; score?: number }) {
  const reduce = useReducedMotion();
  const s = p.source;
  const hasLink = !!(s.videoId || s.url);
  const copy = async () => {
    try { await navigator.clipboard.writeText(formatCitation(p)); toast('Citation copiée.', 'success'); }
    catch { toast('Copie impossible.', 'error'); }
  };
  const del = async () => {
    if (!(await confirmAction(`Supprimer le principe « ${p.title} » de la base de connaissances ?`, { danger: true, confirmLabel: 'Supprimer' }))) return;
    await engine.remove([p.id]);
    toast('Principe supprimé.', 'success');
  };
  return (
    <motion.article className="glass kn-card" layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 10, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={reduce ? undefined : { opacity: 0, scale: 0.97 }}
      transition={{ ...SPRING, delay: reduce ? 0 : Math.min(index, 12) * 0.025 }}>
      <div className="kn-card-top">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <TopicChip topic={p.topic} /><span className="kn-kind">{KIND_LABELS[s.kind]}</span>
        </div>
        <div className="kn-card-actions">
          <button className="kn-icon-btn" title="Copier la citation" aria-label="Copier la citation" onClick={copy}>⧉</button>
          <button className="kn-icon-btn danger" title="Supprimer" aria-label="Supprimer le principe" onClick={del}>✕</button>
        </div>
      </div>
      <div className="kn-card-title">{p.title}</div>
      <div className="kn-card-text">{p.text}</div>
      {score != null && <div className="kn-score" title={`Pertinence ${Math.round(score * 100)} %`}><i style={{ width: `${Math.round(score * 100)}%` }} /></div>}
      <button className="kn-src" disabled={!hasLink} onClick={() => void openSource(p)} title={hasLink ? 'Ouvrir la source' : undefined}>
        <span aria-hidden>{s.kind === 'youtube' ? '▶' : s.kind === 'document' ? '📄' : '📚'}</span>
        <b>{s.creator}</b>
        {s.timestamp != null && <span className="kn-ts">{fmtTime(s.timestamp)}</span>}
        {s.videoTitle && <span className="kn-ell">· {s.videoTitle}</span>}
        {hasLink && <span aria-hidden>↗</span>}
      </button>
    </motion.article>
  );
}

/** Carte de progression de la tâche en cours (mise à jour, import…). */
export function JobPanel({ showLog = false }: { showLog?: boolean }) {
  const job = useKnJob();
  const [open, setOpen] = useState(showLog);
  const reduce = useReducedMotion();
  if (!job.running && !job.log.length) return null;
  const pct = job.total ? ((job.done + job.sub) / job.total) * 100 : 0;
  const last = job.log[job.log.length - 1];
  return (
    <motion.div className="glass kn-job" initial={reduce ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
      <div className="kn-job-row">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="kn-job-phase">{job.running ? <><span className="kn-dot busy" />{job.phase || job.label}</> : <><span className={`kn-dot ${last?.level === 'error' ? 'bad' : 'ok'}`} />{job.label} — terminé</>}</div>
          {job.current && <div className="kn-job-current">{job.current}</div>}
        </div>
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setOpen(o => !o)}>{open ? 'Masquer le journal' : 'Journal'}</Button>
          {job.running && <Button size="sm" variant="secondary" onClick={cancelJob}>Annuler</Button>}
        </div>
      </div>
      {job.running && <ProgressBar value={pct} indeterminate={!job.total} />}
      <div className="kn-job-meta">
        {job.total > 0 && <span>{Math.min(job.done + (job.running ? 1 : 0), job.total)}/{job.total}</span>}
        {job.quotaBudget > 0 && <span>Quota YouTube : {job.quotaUsed}/{job.quotaBudget} unités</span>}
        <span>{job.added} principe(s) ajouté(s)</span>
        {job.duplicates > 0 && <span>{job.duplicates} doublon(s) écarté(s)</span>}
        {!job.running && job.finishedAt && <span>{fmtAgo(job.finishedAt)}</span>}
      </div>
      {open && <div className="kn-log" aria-live="polite">{job.log.map((l, i) => <div key={i} className={l.level}><time>{new Date(l.at).toLocaleTimeString('fr-FR')}</time>{l.text}</div>)}</div>}
    </motion.div>
  );
}
