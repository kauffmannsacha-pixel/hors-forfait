// Panneaux de la page Script : brief, plan minuté, score en direct, bulle de conseil, écriture en direct.
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Button, Field, Input, Score, Select, SourceCite, Spinner, TextArea } from '../../ui/kit';
import { SECTION_DEFS, STYLES, sectionDef, styleDef, type SectionKind, type ScriptStyle } from './method';
import { countWords, fmtClock, type ScriptAnalysis } from './heuristics';
import type { PlacedIssue } from './plugin';
import type { EvalKey, IdeaTest, ScriptEval, ScriptMeta } from './store';
import { EVAL_LABELS } from './ai';
import { fmt1, PopMenu, MenuItem, ScoreRing, SPRING, useDraft } from './ui';

const shortDur = (s: number) => { const r = Math.round(s); return r < 60 ? `${r} s` : `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
const parseClock = (s: string): number | null => {
  const m = /^\s*(?:(\d{1,3})\s*[:'m]\s*)?(\d{1,2})?\s*s?\s*$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  return (Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
};

// ── Brief ─────────────────────────────────────────────────────
export function IdeaTestView({ test, onUseVariant }: { test: IdeaTest; onUseVariant?: (v: string) => void }) {
  const verdict = { go: ['Go : l\'idée passe les 2 tests', 'var(--good)'], retravailler: ['À retravailler avant d\'écrire', 'var(--warn)'], changer: ['Change d\'idée : aucune écriture ne la sauvera', 'var(--bad)'] }[test.verdict];
  return (
    <div className="sc-ideatest">
      <div className="sc-tests">
        {([['Compréhensible en 2 s', test.comprehensible], ['Remarquable', test.remarquable]] as const).map(([label, t]) => (
          <div key={label} className={`sc-test ${t.ok ? 'ok' : 'ko'}`}>
            <div className="sc-test-head"><span className="sc-test-mark" aria-hidden>{t.ok ? '✓' : '✕'}</span><b>{label}</b><Score value={t.note} /></div>
            <div className="muted sc-small">{t.pourquoi}</div>
          </div>
        ))}
      </div>
      <div className="sc-verdict" style={{ color: verdict[1] }}>{verdict[0]}</div>
      {test.concept && <div className="sc-small"><span className="muted">Concept : </span>{test.concept}</div>}
      {onUseVariant && test.variantes.length > 0 && (
        <div className="sc-variants">
          <span className="muted sc-small">Variantes plus fortes :</span>
          {test.variantes.map(v => <button key={v} type="button" className="sc-variant" onClick={() => onUseVariant(v)}>{v}</button>)}
        </div>
      )}
    </div>
  );
}

export function BriefCard({ meta, onChange, onTest, testing }: { meta: ScriptMeta; onChange: (p: Partial<ScriptMeta>) => void; onTest: (idea: string) => void; testing: boolean }) {
  const [idea, setIdea] = useDraft(meta.idea, v => onChange({ idea: v }));
  const [title, setTitle] = useDraft(meta.plannedTitle, v => onChange({ plannedTitle: v }));
  const [thumb, setThumb] = useDraft(meta.plannedThumbnail, v => onChange({ plannedThumbnail: v }));
  const [payoff, setPayoff] = useDraft(meta.payoff, v => onChange({ payoff: v }));
  const st = styleDef(meta.style);
  const presets = st.durations.includes(meta.targetSec) ? st.durations : [...st.durations, meta.targetSec].sort((a, b) => a - b);
  const stale = meta.ideaTest && meta.ideaTest.idea.trim() !== idea.trim();
  const [custom, setCustom] = useState(false);
  return (
    <div className="sc-brief glass">
      <div className="sc-brief-grid">
        <div className="sc-brief-idea">
          <Field label="Idée de la vidéo" hint="Étape 0 : compréhensible en 2 secondes + remarquable, sinon on n'écrit pas.">
            <TextArea rows={2} value={idea} onChange={e => setIdea(e.target.value)} placeholder="« Je dessine un inconnu au hasard et je dois le retrouver dans la vraie vie »" />
          </Field>
          <div className="row">
            <Button size="sm" variant={meta.ideaTest && !stale ? 'secondary' : 'primary'} loading={testing} disabled={!idea.trim()} onClick={() => onTest(idea)}>{meta.ideaTest ? 'Re-tester l\'idée' : 'Tester l\'idée avec Claude'}</Button>
            {stale && <span className="muted sc-small">L'idée a changé depuis le dernier test.</span>}
          </div>
          {meta.ideaTest && <IdeaTestView test={meta.ideaTest} onUseVariant={v => { setIdea(v); onChange({ idea: v }); }} />}
        </div>
        <div className="sc-brief-side">
          <div className="sc-brief-row">
            <Field label="Style">
              <Select value={meta.style} onChange={e => { const s = e.target.value as ScriptStyle; onChange({ style: s, targetSec: styleDef(s).defaultSec }); }}>
                {STYLES.map(s => <option key={s.id} value={s.id}>{s.icon} {s.label}</option>)}
              </Select>
            </Field>
            <Field label="Durée cible">
              {custom
                ? <Input autoFocus defaultValue={fmtClock(meta.targetSec)} placeholder="m:ss" aria-label="Durée cible personnalisée (m:ss)"
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setCustom(false); }}
                    onBlur={e => { const v = parseClock(e.target.value); if (v && v > 0) onChange({ targetSec: v }); setCustom(false); }} />
                : <Select value={String(meta.targetSec)} onChange={e => { if (e.target.value === 'custom') setCustom(true); else onChange({ targetSec: Number(e.target.value) }); }}>
                    {presets.map(d => <option key={d} value={d}>{fmtClock(d)}</option>)}
                    <option value="custom">Autre…</option>
                  </Select>}
            </Field>
            <Field label="Débit (mots/min)">
              <Input type="number" min={90} max={260} step={5} value={meta.wpm} onChange={e => { const v = Number(e.target.value); if (v >= 60 && v <= 320) onChange({ wpm: v }); }} />
            </Field>
          </div>
          <div className="muted sc-small sc-style-tip">{st.icon} <b>{st.structure}</b> — {st.tip}</div>
          <Field label="Titre prévu"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Le script doit honorer exactement sa promesse" /></Field>
          <Field label="Miniature prévue"><Input value={thumb} onChange={e => setThumb(e.target.value)} placeholder="Ce qu'on voit en 1 s (la 1re phrase la confirme)" /></Field>
          <Field label="Payoff final" hint="On écrit la fin avant le début."><Input value={payoff} onChange={e => setPayoff(e.target.value)} placeholder="La révélation / le résultat qui tient la promesse" /></Field>
        </div>
      </div>
    </div>
  );
}

// ── Plan minuté ───────────────────────────────────────────────
export function PlanRail({ analysis, onJump, onAdd }: { analysis: ScriptAnalysis | null; onJump: (blockIndex: number) => void; onAdd: (kind: SectionKind | 'libre') => void }) {
  const sections = analysis?.sections.filter(s => s.b >= 0) ?? [];
  return (
    <nav className="sc-plan glass" aria-label="Plan du script">
      <div className="sc-panel-title">Plan</div>
      {sections.length === 0 && <div className="muted sc-small">Ajoute des sections (titres) pour voir le timing de chaque bloc.</div>}
      <ol className="sc-plan-list">
        {sections.map(s => {
          const def = sectionDef(s.kind);
          const ratio = s.target ? Math.min(1.25, s.dur / s.target) : 0;
          return (
            <li key={s.index}>
              <button type="button" className={`sc-plan-item sc-${s.status}`} onClick={() => onJump(s.b)} title={def?.guidance ?? s.title}>
                <span className="sc-plan-dot" style={{ background: def?.color ?? 'var(--muted)' }} aria-hidden />
                <span className="sc-plan-name">{s.title || 'Sans titre'}</span>
                <span className="sc-plan-time">{s.kind === 'notes' ? 'notes' : fmtClock(s.start)}</span>
                {s.kind !== 'notes' && (
                  <span className="sc-plan-bar" aria-hidden>
                    <motion.span className="sc-plan-fill" initial={false} animate={{ width: `${Math.min(100, (s.target ? ratio : s.words ? 1 : 0) * 100)}%` }} transition={SPRING} />
                  </span>
                )}
                {s.kind !== 'notes' && <span className="sc-plan-dur">{shortDur(s.dur)}{s.target ? ` / ${shortDur(s.target)}` : ''}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <PopMenu label="＋ Section" className="sc-plan-add">
        {close => <>
          {SECTION_DEFS.map(d => <MenuItem key={d.kind} icon={<span className="sc-plan-dot" style={{ background: d.color }} />} title={d.heading} desc={d.guidance.split('.')[0]} onClick={() => { onAdd(d.kind); close(); }} />)}
          <MenuItem icon="＋" title="Section libre" desc="Palier, sponsor intégré, fil parallèle…" onClick={() => { onAdd('libre'); close(); }} />
        </>}
      </PopMenu>
    </nav>
  );
}

// ── Score en direct ───────────────────────────────────────────
export interface ScorePanelProps {
  analysis: ScriptAnalysis | null; aiEval: ScriptEval | null; aiStale: boolean; evalBusy: boolean; evalError: string | null;
  liveEval: boolean; onToggleLive: () => void; onEvalNow: () => void; onWpm: (wpm: number) => void; wpm: number;
  issues: PlacedIssue[]; citations: Record<string, string | null>; rewriteId: string | null;
  onReveal: (i: PlacedIssue) => void; onApply: (i: PlacedIssue) => void; onIgnore: (i: PlacedIssue) => void; onRevealExcerpt: (excerpt: string) => void;
}
export function ScorePanel(p: ScorePanelProps) {
  const a = p.analysis;
  const combined = a ? (p.aiEval ? Math.round((0.6 * p.aiEval.global + 0.4 * a.score) * 10) / 10 : a.score) : null;
  const durState = a?.targetSec ? (a.durationSec > a.targetSec * 1.15 ? 'over' : a.durationSec < a.targetSec * 0.75 ? 'under' : 'ok') : 'free';
  const sorted = useMemo(() => [...p.issues].sort((x, y) => (x.from ?? 1e9) - (y.from ?? 1e9)), [p.issues]);
  return (
    <aside className="sc-score" aria-label="Score en direct">
      <div className="glass sc-score-card">
        <div className="sc-score-top">
          <ScoreRing value={a && a.words ? combined : null} label="Score du script" />
          <div className="sc-score-sub">
            <div className="sc-panel-title">Score en direct</div>
            <div className="sc-small"><span className="muted">Local</span> <b>{a ? fmt1(a.score) : '–'}</b>
              <span className="muted"> · Claude </span><b>{p.aiEval ? fmt1(p.aiEval.global) : '–'}</b>
              {p.evalBusy && <> <Spinner /></>}
            </div>
            <div className="sc-small muted">{p.aiEval ? `Évalué ${formatDistanceToNow(p.aiEval.at, { locale: fr, addSuffix: true })}${p.aiStale ? ' (version précédente)' : ''}` : 'Évaluation Claude après une pause d\'écriture'}</div>
          </div>
        </div>
        {a && (
          <div className="sc-metrics">
            <div className={`sc-metric sc-${durState}`}><span>Durée</span><b>{fmtClock(a.durationSec)}</b><em>{a.targetSec ? `cible ${fmtClock(a.targetSec)}` : `${a.words} mots`}</em></div>
            <div className="sc-metric"><span>Débit</span>
              <b className="sc-wpm"><button type="button" aria-label="Diminuer le débit" onClick={() => p.onWpm(p.wpm - 5)}>−</button>{p.wpm}<button type="button" aria-label="Augmenter le débit" onClick={() => p.onWpm(p.wpm + 5)}>+</button></b>
              <em>{a.requiredWpm ? `${a.requiredWpm} nécessaires` : 'mots/min'}</em></div>
            <div className={`sc-metric ${a.openLoops ? 'sc-ok' : 'sc-over'}`}><span>Boucles</span><b>{a.openLoops}</b><em>{a.questions} question{a.questions > 1 ? 's' : ''}</em></div>
            <div className={`sc-metric ${a.deadZones.length ? 'sc-over' : 'sc-ok'}`}><span>Moments morts</span><b>{a.deadZones.length}</b><em>&gt; {a.isShort ? 12 : 35} s sans relance</em></div>
            <div className={`sc-metric ${a.hookSec != null && a.hookSec > (a.isShort ? 3 : 5) ? 'sc-over' : 'sc-ok'}`}><span>Hook</span><b>{a.hookSec != null ? `${Math.round(a.hookSec)} s` : '–'}</b><em>1re phrase &lt; {a.isShort ? 3 : 5} s</em></div>
            <div className={`sc-metric ${a.escalations >= (a.isShort ? 1 : 3) ? 'sc-ok' : ''}`}><span>Paliers</span><b>{a.escalations}</b><em>{a.twists} rebondissement{a.twists > 1 ? 's' : ''}</em></div>
          </div>
        )}
        {a && a.words > 0 && (
          <div className="sc-parts">
            {a.parts.map(part => (
              <div key={part.id} className="sc-part" title={part.detail}>
                <span>{part.label}</span>
                <span className="sc-part-bar" aria-hidden><motion.span initial={false} animate={{ width: `${part.score * 10}%` }} transition={SPRING} style={{ background: part.score >= 7.5 ? 'var(--good)' : part.score >= 5 ? 'var(--warn)' : 'var(--bad)' }} /></span>
                <b>{fmt1(part.score)}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="glass sc-score-card">
        <div className="card-head">
          <div className="sc-panel-title">Évaluation Claude</div>
          <div className="row">
            <label className="sc-switch" title="Évaluer automatiquement après une pause d'écriture">
              <input type="checkbox" checked={p.liveEval} onChange={p.onToggleLive} /><span aria-hidden />Auto
            </label>
            <Button size="sm" variant="ghost" onClick={p.onEvalNow} loading={p.evalBusy} disabled={!a?.words}>Évaluer</Button>
          </div>
        </div>
        {p.evalError && <div className="sc-error sc-small">Évaluation Claude indisponible : {p.evalError}</div>}
        {p.aiEval ? (
          <div className="sc-evals">
            {(Object.keys(EVAL_LABELS) as EvalKey[]).map(k => (
              <div key={k} className="sc-eval">
                <div className="sc-eval-head"><span>{EVAL_LABELS[k]}</span><Score value={p.aiEval!.notes[k].note} /></div>
                {p.aiEval!.notes[k].raison && <div className="muted sc-small">{p.aiEval!.notes[k].raison}</div>}
              </div>
            ))}
            {p.aiEval.premierMomentMort && (
              <button type="button" className="sc-first-dead" onClick={() => p.onRevealExcerpt(p.aiEval!.premierMomentMort!)}>
                <span className="muted sc-small">Premier moment sans question ouverte (le spectateur part là) :</span>
                <span className="sc-small">« {p.aiEval.premierMomentMort} »</span>
              </button>
            )}
          </div>
        ) : !p.evalError && <div className="muted sc-small">{a && a.words >= 40 ? 'Claude note le hook, la promesse, les boucles, l\'escalade, le rythme et le payoff dès que tu fais une pause.' : 'Écris au moins quelques phrases pour lancer l\'évaluation.'}</div>}
      </div>

      <div className="glass sc-score-card">
        <div className="sc-panel-title">Conseils <span className="muted">({sorted.length})</span></div>
        {sorted.length === 0 && <div className="muted sc-small">{a && a.words ? 'Aucun problème détecté. Chaque seconde donne une raison de regarder la suivante.' : 'Les conseils apparaissent soulignés dans le texte pendant que tu écris.'}</div>}
        <ul className="sc-issues">
          {sorted.map(i => (
            <li key={i.id} className={`sc-issue sc-issue-${i.severity}${i.source === 'claude' ? ' sc-issue-ai' : ''}`}>
              <div className="sc-issue-msg">{i.t != null && <span className="sc-issue-t">{fmtClock(i.t)}</span>}{i.message}</div>
              {i.method && <div className="sc-issue-src muted">{i.method}</div>}
              {(i.citation ?? p.citations[i.type]) && <SourceCite text={(i.citation ?? p.citations[i.type]) as string} />}
              <div className="sc-issue-actions">
                {i.from != null && <Button size="sm" variant="ghost" onClick={() => p.onReveal(i)}>Voir</Button>}
                {i.from != null && i.fix && <Button size="sm" variant="ghost" loading={p.rewriteId === i.id} disabled={!!p.rewriteId && p.rewriteId !== i.id} onClick={() => p.onApply(i)}>Appliquer</Button>}
                <Button size="sm" variant="ghost" onClick={() => p.onIgnore(i)}>Ignorer</Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

// ── Bulle au survol d'un soulignement ─────────────────────────
export function SuggestionBubble({ issue, rect, citation, rewrite, onApply, onIgnore, onStop, onEnter, onLeave }: {
  issue: PlacedIssue; rect: DOMRect; citation: string | null | undefined; rewrite: { text: string } | null;
  onApply: () => void; onIgnore: () => void; onStop: () => void; onEnter: () => void; onLeave: () => void;
}) {
  const reduce = useReducedMotion();
  const W = 360;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - W - 12));
  const below = rect.bottom + 10 + 220 < window.innerHeight;
  const style = below ? { left, top: rect.bottom + 8, width: W } : { left, bottom: window.innerHeight - rect.top + 8, width: W };
  return (
    <motion.div role="dialog" aria-label="Conseil" className="glass sc-bubble" style={{ ...style, transformOrigin: below ? 'top left' : 'bottom left' }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, filter: 'blur(6px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, filter: 'blur(4px)' }} transition={reduce ? { duration: 0.12 } : SPRING}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className={`sc-bubble-kind sc-issue-${issue.severity}`}>{issue.source === 'claude' ? '✦ Claude' : issue.severity === 'error' ? 'À corriger' : issue.severity === 'warn' ? 'Rétention' : 'Rythme'}</div>
      <div className="sc-bubble-msg">{issue.message}</div>
      {issue.method && <div className="sc-issue-src muted">{issue.method}</div>}
      {(issue.citation ?? citation) && <SourceCite text={(issue.citation ?? citation) as string} />}
      {rewrite && <div className="sc-bubble-preview" aria-live="polite">{rewrite.text || <span className="muted">Claude réécrit le passage…</span>}</div>}
      <div className="sc-issue-actions">
        {rewrite
          ? <Button size="sm" variant="secondary" onClick={onStop}>Arrêter</Button>
          : issue.fix && issue.from != null && <Button size="sm" variant="primary" onClick={onApply}>Appliquer</Button>}
        {!rewrite && <Button size="sm" variant="ghost" onClick={onIgnore}>Ignorer</Button>}
      </div>
    </motion.div>
  );
}

// ── Écriture en direct (streaming de la génération) ───────────
export function LiveWriter({ text, label, onStop }: { text: string; label: string; onStop: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  useEffect(() => { const el = box.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [html]);
  const words = countWords(text.split('\n').filter(l => /voix\s*:/i.test(l)).join(' ').replace(/\*\*?voix\s*:\*?\*?/gi, ''));
  return (
    <div className="sc-live glass">
      <div className="sc-live-head">
        <span className="sc-live-dot" aria-hidden /> <b>{label}</b>
        <span className="muted sc-small">{words ? `${words} mots parlés` : 'Préparation…'}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="secondary" onClick={onStop}>Arrêter</Button>
      </div>
      <div className="sc-live-body prose" ref={box} onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}
        aria-live="polite" dangerouslySetInnerHTML={{ __html: html + '<span class="sc-caret"></span>' }} />
    </div>
  );
}

export const sectionHeading = (kind: SectionKind | 'libre') => sectionDef(kind as SectionKind)?.heading ?? 'Nouvelle section';
