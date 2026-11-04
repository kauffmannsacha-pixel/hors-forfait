// Page « Script » (kind 'script') : structure guidée, timing en marge, score en direct, conseils inline, génération Claude.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Editor, EditorEvents, JSONContent } from '@tiptap/core';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { BlockEditor } from '../../editor/BlockEditor';
import { getActiveEditor, setActiveEditor } from '../../editor/active';
import { updatePage, usePages } from '../../db/pages';
import type { Page } from '../../db/types';
import { confirmAction, openView, toast } from '../../ui/appState';
import { Button, Empty, Sheet } from '../../ui/kit';
import { isAbortError } from '../../claude/api';
import { analyzeScript, fmtClock, hashStr, type ScriptAnalysis } from './heuristics';
import { hasWrittenText, markdownToDoc, scriptToPrompt, stripFences } from './doc';
import { buildDecorations, findExcerpt, indexDoc, pushDecorations, rangeToPos, replaceWithText, revealPos, sanitizeJSON, ScriptAssist, spokenText, type PMIndex, type PlacedIssue } from './plugin';
import { citationFor, evaluateScript, generateScript, rewritePassage, testIdea } from './ai';
import { loadAnalyses, loadScriptSettings, readMeta, saveScriptSettings, useAnalyses, useScriptSettings, useScriptUi, writeMeta, type ScriptEval, type ScriptMeta } from './store';
import { styleDef, type IssueType, type SectionKind } from './method';
import { BriefCard, LiveWriter, PlanRail, ScorePanel, SuggestionBubble, sectionHeading } from './ScriptPanels';
import { copyText, MenuItem, PopMenu, SPRING, useDraft, useLatest } from './ui';
import './script.css';

const EXTRA = [ScriptAssist];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function timeAt(ix: PMIndex, a: ScriptAnalysis, pos: number): number | undefined {
  for (let b = ix.blocks.length - 1; b >= 0; b--) if (ix.maps[b][0] <= pos) return a.blockTimes[b] ?? undefined;
  return undefined;
}

export function ScriptPage({ page }: { page: Page }) {
  const live = usePages(s => s.pages[page.id]) ?? page;
  const meta = useMemo(() => readMeta(live), [live]);
  const settings = useScriptSettings();
  const analyses = useAnalyses(s => s.list);
  const [initialContent] = useState(() => live.content);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
  const [issues, setIssues] = useState<PlacedIssue[]>([]);
  const [aiEval, setAiEval] = useState<ScriptEval | null>(meta.lastEval ?? null);
  const [curHash, setCurHash] = useState('');
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [citations, setCitations] = useState<Record<string, string | null>>({});
  const [gen, setGen] = useState<{ text: string; label: string } | null>(null);
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [rewrite, setRewrite] = useState<{ id: string; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [briefOpen, setBriefOpen] = useState(() => !readMeta(page).idea.trim());
  const [pickRef, setPickRef] = useState(false);
  const [title, setTitle] = useDraft(live.title, v => { void updatePage(page.id, { title: v }); });

  const edRef = useRef<Editor | null>(null);
  const metaRef = useLatest(meta);
  const liveRef = useLatest(live);
  const settingsRef = useLatest(settings);
  const rewriteRef = useLatest(rewrite);
  const aiEvalRef = useRef<ScriptEval | null>(aiEval);
  const ixRef = useRef<PMIndex | null>(null);
  const analysisRef = useRef<ScriptAnalysis | null>(null);
  const flashRef = useRef<{ from: number; to: number } | null>(null);
  const timers = useRef<Record<'analyze' | 'eval' | 'save' | 'flash' | 'hide', number | undefined>>({ analyze: undefined, eval: undefined, save: undefined, flash: undefined, hide: undefined });
  const pendingSave = useRef<unknown>(null);
  const genOn = useRef(false);
  const genText = useRef('');
  const raf = useRef(0);
  const genAbort = useRef<AbortController | null>(null);
  const evalAbort = useRef<AbortController | null>(null);
  const evalInFlight = useRef(false);
  const evalQueued = useRef(false);
  const evalBlocked = useRef(false);
  const rewriteAbort = useRef<AbortController | null>(null);
  const track = useRef<{ from: number; to: number } | null>(null);
  const pendingHandled = useRef(false);

  // ── Analyse locale (débouncée) → décorations + conseils ──
  function analyze() {
    const ed = edRef.current;
    if (!ed || ed.isDestroyed) return;
    const m = metaRef.current;
    const ix = indexDoc(ed.state.doc);
    const a = analyzeScript(ix.blocks, { wpm: m.wpm, targetSec: m.targetSec, style: m.style, deadZoneSec: settingsRef.current.deadZoneSec });
    const ignored = new Set(m.ignored);
    const placed: PlacedIssue[] = [];
    for (const is of a.issues) {
      if (ignored.has(is.id)) continue;
      const pos = is.range ? rangeToPos(ix, is.range) : null;
      placed.push({ id: is.id, source: 'local', type: is.type, severity: is.severity, message: is.message, fix: is.fix, method: is.method, from: pos?.from, to: pos?.to, excerpt: is.excerpt, t: is.t });
    }
    for (const s of aiEvalRef.current?.suggestions ?? []) {
      const id = 'ai:' + hashStr(`${s.extrait}|${s.conseil}`);
      if (ignored.has(id)) continue;
      const pos = s.extrait ? findExcerpt(ix, s.extrait) : null;
      if (s.extrait && !pos) continue; // passage modifié depuis l'évaluation : conseil périmé
      placed.push({ id, source: 'claude', type: s.type, severity: 'warn', message: s.conseil, fix: `Applique ce conseil : ${s.conseil}`, method: 'Évaluation Claude — checklist de critique de la méthode', citation: s.citation ?? null, from: pos?.from, to: pos?.to, excerpt: s.extrait, t: pos ? timeAt(ix, a, pos.from) : undefined });
    }
    pushDecorations(ed, buildDecorations(ed.state.doc, ix, a, placed, flashRef.current));
    ixRef.current = ix; analysisRef.current = a;
    setAnalysis(a); setIssues(placed);
    const promptText = scriptToPrompt(ix.blocks, a.blockTimes);
    const hash = hashStr(promptText);
    setCurHash(hash);
    scheduleEval(promptText, hash, a);
  }
  const scheduleAnalyze = (delay = 250) => { clearTimeout(timers.current.analyze); timers.current.analyze = window.setTimeout(() => fns.current.analyze(), delay); };

  // ── Évaluation Claude débouncée (modèle rapide) ──
  function scheduleEval(promptText: string, hash: string, a: ScriptAnalysis) {
    clearTimeout(timers.current.eval);
    if (!settingsRef.current.liveEval || evalBlocked.current || genOn.current || a.words < 40 || aiEvalRef.current?.hash === hash) return;
    timers.current.eval = window.setTimeout(() => void fns.current.runEval(promptText, hash, a), settingsRef.current.evalDelaySec * 1000);
  }
  async function runEval(promptText: string, hash: string, a: ScriptAnalysis) {
    if (evalInFlight.current) { evalQueued.current = true; return; }
    evalInFlight.current = true; setEvalBusy(true); setEvalError(null);
    const ctrl = new AbortController(); evalAbort.current = ctrl;
    try {
      const res = await evaluateScript({ promptText, meta: metaRef.current, title: liveRef.current.title, analysis: a, signal: ctrl.signal });
      const ev: ScriptEval = { ...res, hash, at: Date.now() };
      aiEvalRef.current = ev; setAiEval(ev);
      void writeMeta(page.id, { lastEval: ev });
      fns.current.analyze();
    } catch (e) {
      if (!isAbortError(e)) { const msg = errMsg(e); setEvalError(msg); if (/cl[ée] api|invalide|refus|401|403/i.test(msg)) evalBlocked.current = true; }
    } finally {
      evalInFlight.current = false; evalAbort.current = null; setEvalBusy(false);
      if (evalQueued.current) { evalQueued.current = false; fns.current.analyze(); }
    }
  }
  function evalNow() {
    evalBlocked.current = false;
    analyze();
    const ix = ixRef.current, a = analysisRef.current;
    if (!ix || !a || !a.words) return;
    clearTimeout(timers.current.eval);
    const promptText = scriptToPrompt(ix.blocks, a.blockTimes);
    void runEval(promptText, hashStr(promptText), a);
  }

  // ── Génération complète (streaming) ──
  const scheduleGenRender = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; setGen(g => (g ? { ...g, text: genText.current } : g)); });
  };
  function applyMarkdown(ed: Editor, md: string) {
    if (ed.isDestroyed) return;
    ed.commands.setContent(sanitizeJSON(markdownToDoc(md), ed.schema) as JSONContent);
  }
  async function startGeneration(mode: 'new' | 'rewrite' | 'adapt', referenceId?: string, auto = false) {
    const ed = edRef.current;
    if (!ed || genOn.current) return;
    const m = metaRef.current;
    if (mode !== 'rewrite' && !m.idea.trim()) { toast('Renseigne d\'abord l\'idée de la vidéo dans le brief.', 'warning'); setBriefOpen(true); return; }
    const ix = indexDoc(ed.state.doc);
    const written = hasWrittenText(ix.blocks);
    if (mode === 'rewrite' && !written) { toast('Écris d\'abord un brouillon à réécrire.', 'warning'); return; }
    if (written && !auto && !(await confirmAction('Remplacer le script actuel par la version écrite par Claude ? Tu pourras revenir en arrière avec Ctrl+Z.', { confirmLabel: 'Remplacer' }))) return;
    const reference = mode === 'adapt' ? (await loadAnalyses()).find(x => x.id === referenceId) : undefined;
    if (mode === 'adapt' && !reference) { toast('Analyse de référence introuvable.', 'error'); return; }
    const a = analysisRef.current ?? analyzeScript(ix.blocks, {});
    const current = written ? scriptToPrompt(ix.blocks, a.blockTimes) : undefined;
    const ctrl = new AbortController(); genAbort.current = ctrl; genOn.current = true; genText.current = '';
    clearTimeout(timers.current.eval); evalAbort.current?.abort();
    setHover(null);
    setGen({ text: '', label: mode === 'rewrite' ? 'Claude réécrit ton script avec la méthode' : mode === 'adapt' ? `Claude applique les techniques de « ${reference?.title ?? ''} »` : 'Claude écrit ton script' });
    ed.setEditable(false, false);
    try {
      const { markdown } = await generateScript({ meta: m, title: liveRef.current.title, mode, current, reference, signal: ctrl.signal, onText: full => { genText.current = full; scheduleGenRender(); } });
      applyMarkdown(ed, markdown);
      if (reference) void writeMeta(page.id, { referenceId: reference.id });
      toast('Script écrit par Claude — Ctrl+Z pour revenir à la version précédente.', 'success');
    } catch (e) {
      if (isAbortError(e)) {
        const partial = stripFences(genText.current).trim();
        if (partial.length > 80) { applyMarkdown(ed, partial); toast('Génération arrêtée : le début du script a été inséré (Ctrl+Z pour annuler).', 'info'); }
      } else toast(errMsg(e), 'error');
    } finally {
      genOn.current = false; genAbort.current = null;
      if (!ed.isDestroyed) ed.setEditable(true, false);
      setGen(null);
      scheduleAnalyze(0);
    }
  }

  // ── « Appliquer » : réécriture Claude du passage souligné ──
  async function applyIssue(issue: PlacedIssue) {
    const ed = edRef.current;
    if (!ed || issue.from == null || issue.to == null || !issue.fix || rewriteRef.current || genOn.current) return;
    const { doc } = ed.state;
    const from = issue.from, to = issue.to;
    const passage = doc.textBetween(from, to, '\n', ' ');
    const before = doc.textBetween(Math.max(0, from - 600), from, '\n', ' ').slice(-500);
    const after = doc.textBetween(to, Math.min(doc.content.size, to + 600), '\n', ' ').slice(0, 500);
    track.current = { from, to };
    const ctrl = new AbortController(); rewriteAbort.current = ctrl;
    setRewrite({ id: issue.id, text: '' });
    try {
      const out = await rewritePassage({
        passage, before, after, message: issue.message, fix: issue.fix, meta: metaRef.current, title: liveRef.current.title, signal: ctrl.signal,
        onText: full => setRewrite(r => (r && r.id === issue.id ? { ...r, text: full } : r)),
      });
      const t = track.current;
      if (!t || ed.isDestroyed) return;
      if (ed.state.doc.textBetween(t.from, t.to, '\n', ' ') !== passage) throw new Error('Le passage a été modifié pendant la réécriture : relance « Appliquer ».');
      if (!out.trim()) throw new Error('Claude n\'a renvoyé aucun texte.');
      replaceWithText(ed, t.from, t.to, out);
      setHover(null);
      toast('Passage réécrit par Claude — Ctrl+Z pour annuler.', 'success');
    } catch (e) {
      if (!isAbortError(e)) toast(errMsg(e), 'error');
    } finally { track.current = null; rewriteAbort.current = null; setRewrite(null); }
  }
  function ignoreIssue(issue: PlacedIssue) {
    setHover(null);
    void writeMeta(page.id, { ignored: [...metaRef.current.ignored, issue.id].slice(-300) });
  }
  function flash(from: number, to: number) {
    const ed = edRef.current; if (!ed) return;
    revealPos(ed, from);
    flashRef.current = { from, to };
    analyze();
    clearTimeout(timers.current.flash);
    timers.current.flash = window.setTimeout(() => { flashRef.current = null; fns.current.analyze(); }, 1400);
  }
  function revealExcerpt(excerpt: string) {
    const ix = ixRef.current; const pos = ix ? findExcerpt(ix, excerpt) : null;
    if (pos) flash(pos.from, pos.to); else toast('Passage introuvable : il a été modifié depuis l\'évaluation.', 'info');
  }
  function addSection(kind: SectionKind | 'libre') {
    const ed = edRef.current; if (!ed) return;
    const ix = ixRef.current ?? indexDoc(ed.state.doc);
    const notes = analysisRef.current?.sections.find(s => s.kind === 'notes' && s.b >= 0);
    const at = notes ? ix.tops[ix.topOf[notes.b]].pos : ed.state.doc.content.size;
    const heading = kind === 'libre' ? 'Nouvelle section' : sectionHeading(kind);
    ed.chain().insertContentAt(at, [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] }, { type: 'paragraph' }])
      .setTextSelection(at + heading.length + 3).scrollIntoView().focus().run();
  }
  async function runIdeaTest(idea: string) {
    if (!idea.trim()) return;
    setTesting(true);
    try {
      const m = metaRef.current;
      const t = await testIdea(idea, m.style);
      await writeMeta(page.id, {
        idea, ideaTest: t,
        ...(m.plannedTitle.trim() || !t.titres[0] ? {} : { plannedTitle: t.titres[0] }),
        ...(m.plannedThumbnail.trim() || !t.miniature ? {} : { plannedThumbnail: t.miniature }),
        ...(m.payoff.trim() || !t.payoff ? {} : { payoff: t.payoff }),
      });
      toast(t.verdict === 'go' ? 'L\'idée passe les 2 tests : à toi d\'écrire !' : t.verdict === 'changer' ? 'L\'idée échoue aux tests : regarde les variantes proposées.' : 'Idée à retravailler avant d\'écrire.', t.verdict === 'go' ? 'success' : 'warning');
    } catch (e) { toast(errMsg(e), 'error'); } finally { setTesting(false); }
  }
  async function copySpoken() {
    const a = analysisRef.current;
    if (!a?.sentences.length) { toast('Aucun texte parlé à copier.', 'warning'); return; }
    try { await copyText(spokenText(a)); toast('Texte à lire copié (lignes « Voix » uniquement).', 'success'); } catch (e) { toast(errMsg(e), 'error'); }
  }

  const fns = useLatest({ analyze, runEval, startGeneration });

  // ── Cycle de vie ──
  const onReady = (ed: Editor) => { edRef.current = ed; setEditor(ed); setActiveEditor(ed, page.id); scheduleAnalyze(0); };
  const onChange = (json: unknown) => {
    pendingSave.current = json;
    clearTimeout(timers.current.save);
    timers.current.save = window.setTimeout(() => { const j = pendingSave.current; pendingSave.current = null; if (j != null) void updatePage(page.id, { content: j }); }, 600);
    scheduleAnalyze();
  };
  useEffect(() => { void loadScriptSettings(); void loadAnalyses(); }, []);
  useEffect(() => {
    if (!editor) return;
    const onTx = ({ transaction }: EditorEvents['transaction']) => {
      const t = track.current;
      if (t && transaction.docChanged) { t.from = transaction.mapping.map(t.from, 1); t.to = transaction.mapping.map(t.to, -1); }
    };
    const onFocus = () => setActiveEditor(editor, page.id);
    editor.on('transaction', onTx); editor.on('focus', onFocus);
    return () => { editor.off('transaction', onTx); editor.off('focus', onFocus); if (getActiveEditor()?.editor === editor) setActiveEditor(null); };
  }, [editor, page.id]);
  useEffect(() => {
    if (!editor || pendingHandled.current) return;
    const p = metaRef.current.pending;
    if (!p) return;
    pendingHandled.current = true;
    void writeMeta(page.id, { pending: null });
    void fns.current.startGeneration(p.type === 'adapt' ? 'adapt' : 'new', p.referenceId, true);
  }, [editor, page.id, metaRef, fns]);
  const ignoredKey = meta.ignored.join('|');
  useEffect(() => { if (edRef.current) scheduleAnalyze(0); }, [meta.wpm, meta.targetSec, meta.style, ignoredKey, settings.deadZoneSec, settings.liveEval]);
  useEffect(() => {
    const types = [...new Set(issues.filter(i => i.source === 'local').map(i => i.type))].filter(t => !(t in citations));
    if (!types.length) return;
    let alive = true;
    void Promise.all(types.map(async t => [t, await citationFor(t as IssueType)] as const)).then(r => { if (alive) setCitations(c => ({ ...c, ...Object.fromEntries(r) })); });
    return () => { alive = false; };
  }, [issues, citations]);
  useEffect(() => {
    if (!hover) return;
    const close = () => { if (!rewriteRef.current) setHover(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', key); };
  }, [hover, rewriteRef]);
  useEffect(() => () => {
    for (const t of Object.values(timers.current)) clearTimeout(t);
    if (pendingSave.current != null) { void updatePage(page.id, { content: pendingSave.current }); pendingSave.current = null; }
    genAbort.current?.abort(); evalAbort.current?.abort(); rewriteAbort.current?.abort();
    if (raf.current) cancelAnimationFrame(raf.current);
  }, [page.id]);

  // ── Survol des soulignements ──
  const showFor = (el: HTMLElement) => {
    clearTimeout(timers.current.hide);
    const id = el.getAttribute('data-sug');
    if (!id || (rewriteRef.current && rewriteRef.current.id !== id)) return;
    setHover(h => (h?.id === id ? h : { id, rect: el.getBoundingClientRect() }));
  };
  const scheduleHide = () => { clearTimeout(timers.current.hide); timers.current.hide = window.setTimeout(() => { if (!rewriteRef.current) setHover(null); }, 280); };
  const onOver = (e: ReactMouseEvent) => { const el = (e.target as HTMLElement).closest?.('[data-sug]') as HTMLElement | null; if (el) showFor(el); };
  const onOut = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest?.('[data-sug]');
    if (!el) return;
    const to = e.relatedTarget as HTMLElement | null;
    if (to?.closest?.('[data-sug]') === el) return;
    scheduleHide();
  };
  const hovered = hover ? issues.find(i => i.id === hover.id) : undefined;
  const st = styleDef(meta.style);
  const aiStale = !!aiEval && !!curHash && aiEval.hash !== curHash;

  return (
    <MotionConfig reducedMotion="user">
      <div className="sc-page">
        <header className="sc-head">
          <div className="sc-head-main">
            <span className="sc-head-icon" aria-hidden>{live.icon || '🎬'}</span>
            <input className="sc-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Titre du script" aria-label="Titre du script" />
          </div>
          <div className="sc-head-bar">
            <button type="button" className="sc-brief-toggle" aria-expanded={briefOpen} onClick={() => setBriefOpen(o => !o)}>
              <span>{st.icon} {st.label}</span><span className="muted">·</span><span>{fmtClock(meta.targetSec)}</span><span className="muted">·</span><span>{meta.wpm} mots/min</span>
              {meta.ideaTest && <span className={`sc-mini-test ${meta.ideaTest.comprehensible.ok && meta.ideaTest.remarquable.ok ? 'ok' : 'ko'}`}>{meta.ideaTest.comprehensible.ok && meta.ideaTest.remarquable.ok ? 'Idée validée' : 'Idée à retravailler'}</span>}
              <span className="sc-chevron" aria-hidden>{briefOpen ? '▴' : '▾'}</span>
            </button>
            <span className="sc-grow" />
            <Button variant="ghost" onClick={() => void copySpoken()} disabled={!!gen}>Copier le texte à lire</Button>
            <PopMenu label={<>✨ Claude</>} align="right" disabled={!!gen}>
              {close => <>
                <MenuItem icon="✨" title="Générer le script complet" desc="Depuis le brief, au format de la méthode (timing, voix, visuel, son, boucles)" onClick={() => { close(); void startGeneration('new'); }} />
                <MenuItem icon="♻️" title="Réécrire mon brouillon" desc="Garde tes idées, applique la méthode" onClick={() => { close(); void startGeneration('rewrite'); }} />
                <MenuItem icon="🎯" title="Appliquer une vidéo analysée…" desc="Les techniques d'une vidéo de référence" onClick={() => { close(); void loadAnalyses(); setPickRef(true); }} />
                <MenuItem icon="🔍" title="Analyser une vidéo YouTube" desc="Annoter les techniques d'un script à succès" onClick={() => { close(); useScriptUi.setState({ tab: 'analyse' }); openView('scripts'); }} />
              </>}
            </PopMenu>
          </div>
        </header>

        <AnimatePresence initial={false}>
          {briefOpen && (
            <motion.div key="brief" className="sc-brief-wrap" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={SPRING}>
              <BriefCard meta={meta} testing={testing} onChange={(patch: Partial<ScriptMeta>) => void writeMeta(page.id, patch)} onTest={idea => void runIdeaTest(idea)} />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="sc-layout">
          <PlanRail analysis={analysis} onAdd={addSection} onJump={b => { const ed = edRef.current, ix = ixRef.current; if (ed && ix && ix.pos[b] != null) revealPos(ed, ix.pos[b] + 1); }} />
          <div className="sc-main">
            {gen && <LiveWriter text={gen.text} label={gen.label} onStop={() => genAbort.current?.abort()} />}
            <div className={`sc-paper${gen ? ' sc-hidden' : ''}`} onMouseOver={onOver} onMouseOut={onOut} onClick={e => { const el = (e.target as HTMLElement).closest?.('[data-sug]') as HTMLElement | null; if (el) showFor(el); }}>
              <BlockEditor content={initialContent} onChange={onChange} onReady={onReady} extraExtensions={EXTRA} className="prose sc-prose" />
            </div>
          </div>
          <ScorePanel
            analysis={analysis} aiEval={aiEval} aiStale={aiStale} evalBusy={evalBusy} evalError={evalError}
            liveEval={settings.liveEval} onToggleLive={() => { evalBlocked.current = false; void saveScriptSettings({ liveEval: !settings.liveEval }); }}
            onEvalNow={evalNow} wpm={meta.wpm} onWpm={w => void writeMeta(page.id, { wpm: Math.min(260, Math.max(90, w)) })}
            issues={issues} citations={citations} rewriteId={rewrite?.id ?? null}
            onReveal={i => { if (i.from != null && i.to != null) flash(i.from, i.to); }} onApply={i => void applyIssue(i)} onIgnore={ignoreIssue} onRevealExcerpt={revealExcerpt}
          />
        </div>

        <AnimatePresence>
          {hovered && hover && (
            <SuggestionBubble key={hovered.id} issue={hovered} rect={hover.rect} citation={citations[hovered.type]}
              rewrite={rewrite && rewrite.id === hovered.id ? rewrite : null}
              onApply={() => void applyIssue(hovered)} onIgnore={() => ignoreIssue(hovered)} onStop={() => rewriteAbort.current?.abort()}
              onEnter={() => clearTimeout(timers.current.hide)} onLeave={scheduleHide} />
          )}
        </AnimatePresence>

        <Sheet open={pickRef} onClose={() => setPickRef(false)} title="Appliquer les techniques d'une vidéo analysée">
          {analyses.length === 0
            ? <Empty icon="🔍" title="Aucune vidéo analysée">Analyse d'abord une vidéo (ex. MrBeast) dans Scripts → Analyser une vidéo.</Empty>
            : <div className="sc-ref-list">
                {analyses.map(an => (
                  <button key={an.id} type="button" className="sc-ref-item" onClick={() => { setPickRef(false); void startGeneration('adapt', an.id); }}>
                    <img src={`https://i.ytimg.com/vi/${an.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
                    <span><b>{an.title}</b><span className="muted sc-small">{an.channel ?? ''} · {fmtClock(an.durationSec)} · {an.annotations.length} techniques</span></span>
                  </button>
                ))}
              </div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="ghost" onClick={() => { setPickRef(false); useScriptUi.setState({ tab: 'analyse' }); openView('scripts'); }}>Analyser une nouvelle vidéo</Button>
          </div>
        </Sheet>
      </div>
    </MotionConfig>
  );
}
