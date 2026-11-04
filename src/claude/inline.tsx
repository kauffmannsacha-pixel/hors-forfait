// Commandes « /claude » et actions sur la sélection : petite invite flottante en verre,
// génération insérée en streaming dans l'éditeur, puis « Garder » / « Annuler » / « Réessayer ».
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Editor } from '@tiptap/core';
import { displayTitle, getPage } from '../db/pages';
import { openPage, toast } from '../ui/appState';
import { askClaude, askClaudeJSON, isAbortError } from './api';
import { DATABASE_SYSTEM, INLINE_SYSTEM, LANGUAGES, TONES, inlinePrompt, type InlineAction } from './prompts';
import { StreamInsertion, selectionRange, slashTargets, type InsertRange } from './streamInsert';
import { clipText, docToMarkdown } from './pageText';
import { createDatabaseFromSpec } from './tools';
import { IClose, ISparkle, IStop, IUndo, ICheck, IRefresh } from './icons';
import './claude.css';

export type InlineKind = InlineAction | 'database';
type Phase = 'prompt' | 'streaming' | 'done' | 'error';
type Chip = { id: string; label: string };

interface InlineUi {
  open: boolean;
  phase: Phase;
  kind: InlineKind;
  title: string;
  placeholder: string;
  chips: Chip[];
  chipMode: 'tone' | 'language' | 'suggestion' | null;
  chosen: string | null;
  instruction: string;
  working: string;
  error: string | null;
  pos: { left: number; top: number };
  dbId: string | null;
  targetPreview: string;
}
const initial: InlineUi = {
  open: false, phase: 'prompt', kind: 'write', title: '', placeholder: '', chips: [], chipMode: null, chosen: null,
  instruction: '', working: '', error: null, pos: { left: 0, top: 0 }, dbId: null, targetPreview: '',
};
const useInline = create<InlineUi>(() => initial);

interface Session {
  editor: Editor;
  pageId: string | null;
  /** où insérer le résultat (write/summarize/database) */
  insertAt: InsertRange;
  /** texte à transformer (rewrite, translate, table…) */
  target: (InsertRange & { markdown: string; inline?: boolean }) | null;
  anchorPos: number;
  insertion: StreamInsertion | null;
  controller: AbortController | null;
  text: string;
}
let session: Session | null = null;

const TRANSFORMS: InlineKind[] = ['rewrite', 'shorter', 'longer', 'fix', 'translate', 'table', 'custom'];
const NEEDS_PROMPT: InlineKind[] = ['write', 'rewrite', 'translate', 'custom', 'database'];

const META: Record<InlineKind, { title: string; placeholder: string; chips: Chip[]; chipMode: InlineUi['chipMode'] }> = {
  write: { title: 'Rédiger avec Claude', placeholder: 'Que dois-je écrire ? (ex. un plan de vidéo sur…)', chipMode: 'suggestion', chips: [
    { id: 'Propose 10 idées de vidéos pour ma chaîne à partir de cette page', label: 'Idées de vidéos' },
    { id: 'Écris un plan de script : hook, promesse, corps avec re-hooks, payoff, CTA', label: 'Plan de script' },
    { id: 'Rédige une description YouTube optimisée (résumé, chapitres, liens, hashtags)', label: 'Description YouTube' },
    { id: 'Transforme cette page en liste de tâches concrètes (cases à cocher)', label: 'Liste de tâches' },
    { id: 'Rédige un post communauté YouTube accrocheur pour annoncer la vidéo', label: 'Post communauté' },
  ] },
  continue: { title: 'Continuer la rédaction', placeholder: '', chips: [], chipMode: null },
  summarize: { title: 'Résumer la page', placeholder: '', chips: [], chipMode: null },
  rewrite: { title: 'Réécrire', placeholder: 'Consigne facultative (ex. plus drôle, tutoiement…)', chips: TONES.map(t => ({ id: t.id, label: t.label })), chipMode: 'tone' },
  shorter: { title: 'Raccourcir', placeholder: '', chips: [], chipMode: null },
  longer: { title: 'Développer', placeholder: '', chips: [], chipMode: null },
  fix: { title: 'Corriger l\'orthographe', placeholder: '', chips: [], chipMode: null },
  translate: { title: 'Traduire', placeholder: 'Autre langue ou précision (ex. anglais américain)', chips: LANGUAGES.map(l => ({ id: l.label, label: l.label })), chipMode: 'language' },
  table: { title: 'Transformer en tableau', placeholder: '', chips: [], chipMode: null },
  custom: { title: 'Demander à Claude', placeholder: 'Que faire de ce texte ?', chips: [], chipMode: null },
  database: { title: 'Générer une base de données', placeholder: 'Décris la base (ex. mes sponsors : marque, statut, montant, date limite)', chipMode: 'suggestion', chips: [
    { id: 'Idées de vidéos : titre, statut (Idée, Script, Tournage, Montage, Publié), format, priorité, date de publication prévue', label: 'Idées de vidéos' },
    { id: 'Partenariats et sponsors : marque, contact, statut, montant, date limite, livrables', label: 'Sponsors' },
    { id: 'Calendrier de publication : vidéo, chaîne, date, statut, plateforme', label: 'Calendrier' },
    { id: 'Suivi des tournages : scène, lieu, matériel, date, terminé', label: 'Tournages' },
  ] },
};

// ───────────────────────────── Racine React dédiée ─────────────────────────────

let mounted = false;
function ensureRoot() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const el = document.createElement('div');
  el.id = 'prisme-claude-inline';
  document.body.appendChild(el);
  createRoot(el).render(<InlineHost />);
}

function place(pos?: number) {
  if (!session) return;
  const c = session.insertion?.coords() ?? (() => {
    try { const r = session.editor.view.coordsAtPos(Math.min(pos ?? session.anchorPos, session.editor.state.doc.content.size)); return { left: r.left, top: r.top, bottom: r.bottom }; } catch { return null; }
  })();
  if (!c) return;
  const width = Math.min(520, window.innerWidth - 24);
  const left = Math.max(12, Math.min(c.left, window.innerWidth - width - 12));
  const top = c.bottom + 10 + 150 > window.innerHeight ? Math.max(12, c.top - 160) : c.bottom + 10;
  useInline.setState({ pos: { left, top } });
}

// ───────────────────────────── API publique ─────────────────────────────

/** Depuis le menu « / » : `pos` = position du curseur après suppression du texte de commande. */
export function startSlashAction(editor: Editor, pos: number, kind: InlineKind, pageId: string | null) {
  cancelSession(false);
  const t = slashTargets(editor, pos);
  session = { editor, pageId, insertAt: t.insert, target: t.target, anchorPos: pos, insertion: null, controller: null, text: '' };
  open(kind, t.target?.markdown ?? '');
}

/** Sur la sélection courante de l'éditeur (panneau Claude, raccourcis…). */
export function startSelectionAction(editor: Editor, kind: InlineKind, pageId: string | null, preset?: string) {
  cancelSession(false);
  const r = selectionRange(editor);
  const end = editor.state.selection.to;
  session = { editor, pageId, insertAt: { from: r ? r.to : end, to: r ? r.to : end }, target: r, anchorPos: r ? r.to : end, insertion: null, controller: null, text: '' };
  if (TRANSFORMS.includes(kind) && !r) { toast('Sélectionne d\'abord du texte dans la page.', 'warning'); session = null; return; }
  open(kind, r?.markdown ?? '', preset);
}

function open(kind: InlineKind, targetMd: string, preset?: string) {
  ensureRoot();
  const m = META[kind];
  useInline.setState({ ...initial, open: true, kind, title: m.title, placeholder: m.placeholder, chips: m.chips, chipMode: m.chipMode, targetPreview: clipText(targetMd.replace(/\s+/g, ' ').trim(), 140).text, chosen: preset ?? null });
  place();
  if (!NEEDS_PROMPT.includes(kind) || preset) void run();
}

function closeUi() { useInline.setState({ open: false }); }

function cancelSession(revert: boolean) {
  if (!session) return;
  session.controller?.abort();
  if (session.insertion) { if (revert) session.insertion.revert(); session.insertion.dispose(); }
  session = null;
}

const unwrapFence = (md: string) => {
  const t = md.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  return m ? m[1] : t;
};

async function run() {
  const s = session; if (!s) return;
  const ui = useInline.getState();
  const kind = ui.kind;
  if (TRANSFORMS.includes(kind) && !s.target) {
    useInline.setState({ phase: 'error', error: 'Aucun texte à transformer : écris ou sélectionne un paragraphe, puis relance la commande.' });
    return;
  }
  if (s.insertion) { s.insertion.revert(); s.insertion.dispose(); s.insertion = null; }
  const controller = new AbortController();
  s.controller = controller; s.text = '';
  const page = s.pageId ? getPage(s.pageId) : undefined;
  const pageMd = clipText(docToMarkdown(s.editor.getJSON()), 150_000).text;

  if (kind === 'database') {
    useInline.setState({ phase: 'streaming', working: 'Claude conçoit la base…', error: null });
    try {
      const desc = [ui.chosen, ui.instruction].filter(Boolean).join(' — ');
      if (!desc.trim()) { useInline.setState({ phase: 'prompt', working: '' }); return; }
      const spec = await askClaudeJSON<{ title?: string; icon?: string; title_property?: string; properties?: unknown; rows?: Record<string, unknown>[] }>({
        system: DATABASE_SYSTEM, signal: controller.signal, maxTokens: 16000,
        prompt: `Description de la base à créer : ${desc}\n\n${page ? `Page où elle sera insérée : « ${displayTitle(page)} »\n<page>\n${clipText(pageMd, 20_000).text}\n</page>` : ''}`,
      });
      useInline.setState({ working: 'Création de la base…' });
      const res = await createDatabaseFromSpec({
        title: String(spec.title ?? 'Nouvelle base'), icon: typeof spec.icon === 'string' ? spec.icon : undefined, parentId: s.pageId,
        titleProperty: typeof spec.title_property === 'string' ? spec.title_property : 'Nom', properties: spec.properties, rows: Array.isArray(spec.rows) ? spec.rows : [],
      });
      const title = String(spec.title ?? 'Nouvelle base');
      if (!s.editor.isDestroyed) {
        s.insertion = new StreamInsertion(s.editor, s.insertAt);
        if (s.editor.schema.nodes.pageBlock) s.insertion.insertNode({ type: 'pageBlock', attrs: { pageId: res.id, title } });
        else s.insertion.commit(`🗃️ **${title}** — base de données créée (${res.rows} lignes)`);
      }
      useInline.setState({ phase: 'done', dbId: res.id, working: `Base « ${title} » créée (${res.rows} ligne${res.rows > 1 ? 's' : ''}).` });
    } catch (e) {
      if (isAbortError(e)) { closeUi(); cancelSession(false); return; }
      useInline.setState({ phase: 'error', error: (e as Error).message });
    }
    return;
  }

  const range = TRANSFORMS.includes(kind) ? s.target! : s.insertAt;
  s.insertion = new StreamInsertion(s.editor, range, TRANSFORMS.includes(kind) && !!s.target?.inline);
  useInline.setState({ phase: 'streaming', working: 'Claude écrit…', error: null });
  const tone = ui.chipMode === 'tone' ? ui.chosen ?? undefined : undefined;
  const language = ui.chipMode === 'language' ? (ui.instruction.trim() || ui.chosen || 'anglais') : undefined;
  const instruction = ui.chipMode === 'suggestion' ? [ui.chosen, ui.instruction].filter(Boolean).join(' — ') : ui.chipMode === 'language' ? '' : ui.instruction;
  const prompt = inlinePrompt({
    action: kind as InlineAction, instruction, tone, language, target: s.target?.markdown, pageTitle: page ? displayTitle(page) : '',
    page: kind === 'translate' || kind === 'fix' ? undefined : pageMd,
  });
  let frame = 0;
  const flush = () => { frame = 0; if (session === s && s.insertion) { s.insertion.update(unwrapFence(s.text)); place(); } };
  try {
    const full = await askClaude({
      system: INLINE_SYSTEM, prompt, signal: controller.signal, maxTokens: 16000,
      effort: TRANSFORMS.includes(kind) ? 'low' : 'medium',
      onText: (_d, txt) => { s.text = txt; if (!frame) frame = requestAnimationFrame(flush); },
    });
    if (frame) cancelAnimationFrame(frame);
    if (session !== s) return;
    const final = unwrapFence(full);
    if (!final.trim()) { s.insertion.revert(); useInline.setState({ phase: 'error', error: 'Claude n\'a rien renvoyé.' }); return; }
    s.insertion.commit(final);
    place();
    useInline.setState({ phase: 'done', working: '' });
  } catch (e) {
    if (frame) cancelAnimationFrame(frame);
    if (session !== s) return;
    if (isAbortError(e)) {
      // « Arrêter » : on garde ce qui a été écrit, l'utilisateur choisit ensuite.
      if (s.text.trim()) { s.insertion?.commit(unwrapFence(s.text)); useInline.setState({ phase: 'done', working: 'Génération arrêtée.' }); }
      else { s.insertion?.revert(); s.insertion?.dispose(); s.insertion = null; useInline.setState({ phase: 'prompt', working: '' }); }
      return;
    }
    s.insertion?.revert(); s.insertion?.dispose(); s.insertion = null;
    useInline.setState({ phase: 'error', error: (e as Error).message });
  }
}

function keep() {
  const s = session;
  if (s) { s.insertion?.dispose(); try { s.editor.commands.focus(); } catch { /* éditeur fermé */ } }
  session = null; closeUi();
}
function discard() { cancelSession(true); closeUi(); }
function stop() { session?.controller?.abort(); }
function retry() { if (session?.insertion) { session.insertion.revert(); session.insertion.dispose(); session.insertion = null; } void run(); }

// ───────────────────────────── Composant ─────────────────────────────

function InlineHost() {
  const ui = useInline();
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!ui.open) return;
    let raf = 0;
    const onMove = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); force(x => x + 1); }); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => { window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); if (raf) cancelAnimationFrame(raf); };
  }, [ui.open]);

  useEffect(() => { if (ui.open && ui.phase === 'prompt') setTimeout(() => inputRef.current?.focus(), 30); }, [ui.open, ui.phase]);

  useEffect(() => {
    if (!ui.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      const p = useInline.getState().phase;
      if (p === 'streaming') stop();
      else if (p === 'prompt' || p === 'error') discard();
      else keep();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ui.open]);

  const submit = () => { if (ui.kind === 'database' && !ui.instruction.trim() && !ui.chosen) return; void run(); };
  const spring = reduce ? { duration: 0 } : { type: 'spring' as const, bounce: 0, duration: 0.32 };

  return (
    <AnimatePresence>
      {ui.open && (
        <motion.div
          key="inline"
          className="glass cl-inline"
          role="dialog"
          aria-label={ui.title}
          style={{ left: ui.pos.left, top: ui.pos.top }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
          transition={spring}
          onPointerDown={e => e.stopPropagation()}
        >
          <div className="cl-inline-head">
            <span className="cl-inline-icon"><ISparkle size={15} /></span>
            <span className="cl-inline-title">{ui.title}</span>
            {ui.targetPreview && ui.phase === 'prompt' && <span className="cl-inline-target" title={ui.targetPreview}>« {ui.targetPreview} »</span>}
            <button className="cl-icon-btn" aria-label="Fermer" onClick={() => (ui.phase === 'done' ? keep() : discard())}><IClose size={14} /></button>
          </div>

          {ui.phase === 'prompt' && (
            <>
              {ui.chips.length > 0 && (
                <div className="cl-inline-chips">
                  {ui.chips.map(c => (
                    <button key={c.id} className={`cl-pill${ui.chosen === c.id ? ' on' : ''}`}
                      onClick={() => {
                        useInline.setState({ chosen: ui.chosen === c.id ? null : c.id });
                        if (ui.chipMode === 'language' || ui.chipMode === 'tone') void run();
                      }}>{c.label}</button>
                  ))}
                </div>
              )}
              {ui.placeholder && (
                <form className="cl-inline-form" onSubmit={e => { e.preventDefault(); submit(); }}>
                  <input ref={inputRef} className="input" value={ui.instruction} placeholder={ui.placeholder}
                    onChange={e => useInline.setState({ instruction: e.target.value })} />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={ui.kind === 'database' ? !ui.instruction.trim() && !ui.chosen : ui.kind === 'write' && !ui.instruction.trim() && !ui.chosen}>Générer</button>
                </form>
              )}
            </>
          )}

          {ui.phase === 'streaming' && (
            <div className="cl-inline-row">
              <span className="cl-working"><span className="cl-dots"><i /><i /><i /></span>{ui.working}</span>
              <button className="btn btn-sm" onClick={stop}><IStop size={12} /> Arrêter</button>
            </div>
          )}

          {ui.phase === 'done' && (
            <div className="cl-inline-row">
              <span className="cl-working muted">{ui.working || 'Terminé.'}</span>
              <div className="row">
                {ui.dbId ? (
                  <>
                    <button className="btn btn-sm" onClick={() => { const id = ui.dbId!; keep(); openPage(id); }}>Ouvrir la base</button>
                    <button className="btn btn-primary btn-sm" onClick={keep}><ICheck size={13} /> OK</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={retry}><IRefresh size={13} /> Réessayer</button>
                    <button className="btn btn-sm" onClick={discard}><IUndo size={13} /> Annuler</button>
                    <button className="btn btn-primary btn-sm" onClick={keep}><ICheck size={13} /> Garder</button>
                  </>
                )}
              </div>
            </div>
          )}

          {ui.phase === 'error' && (
            <div className="cl-inline-error">
              <span>{ui.error}</span>
              <div className="row">
                <button className="btn btn-sm" onClick={discard}>Fermer</button>
                <button className="btn btn-primary btn-sm" onClick={retry}>Réessayer</button>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
