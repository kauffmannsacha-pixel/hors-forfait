// État d'exécution du panneau Claude (survit à la fermeture du panneau et aux changements de page).
import { create } from 'zustand';
import type Anthropic from '@anthropic-ai/sdk';
import { toast } from '../ui/appState';
import { getModel, getModelCaps, isAbortError } from './api';
import { collectAgentTools, runAgent, type ToolPhase } from './agent';
import { buildUserContent, snapshotContext, type ContextToggles } from './context';
import {
  GLOBAL_KEY, loadConversations, mutateConversations, needsContinuation, newConversation, titleFrom,
  type Conversation, type PageConversations, type TurnNotice,
} from './conversations';
import { CHAT_SYSTEM } from './prompts';

type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type Attachment = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64: string; name: string };

interface RunState { pageKey: string; convId: string; controller: AbortController; live: ContentBlock[] | null; phases: Record<string, ToolPhase>; status: string }

interface ChatState {
  pageKey: string;
  data: PageConversations;
  loading: boolean;
  /** true = l'utilisateur a demandé une nouvelle conversation (pas encore de message). */
  drafting: boolean;
  run: RunState | null;
}

export const useChat = create<ChatState>(() => ({ pageKey: GLOBAL_KEY, data: { v: 1, activeId: null, items: [] }, loading: false, drafting: false, run: null }));

const set = useChat.setState;
const get = useChat.getState;

/** Charge les conversations de la page (ou « global »). */
export async function showPage(pageKey: string) {
  if (get().pageKey === pageKey && !get().loading && get().data.items.length) return;
  set({ pageKey, loading: true, drafting: false });
  const data = await loadConversations(pageKey);
  if (get().pageKey === pageKey) set({ data, loading: false });
}

export const activeConversation = (s: ChatState = get()): Conversation | null =>
  s.drafting ? null : s.data.items.find(c => c.id === s.data.activeId) ?? null;

function applyData(pageKey: string, data: PageConversations) {
  if (get().pageKey === pageKey) set({ data });
}

export function startNewConversation() { set({ drafting: true }); }

export async function selectConversation(id: string) {
  const pageKey = get().pageKey;
  set({ drafting: false });
  applyData(pageKey, await mutateConversations(pageKey, d => ({ ...d, activeId: id })));
}

export async function deleteConversation(id: string) {
  const pageKey = get().pageKey;
  if (get().run?.convId === id) get().run?.controller.abort();
  applyData(pageKey, await mutateConversations(pageKey, d => ({ ...d, items: d.items.filter(c => c.id !== id), activeId: d.activeId === id ? null : d.activeId })));
}

function patchConv(pageKey: string, convId: string, fn: (c: Conversation) => Conversation) {
  return mutateConversations(pageKey, d => ({ ...d, items: d.items.map(c => (c.id === convId ? fn(c) : c)) })).then(data => applyData(pageKey, data));
}

function addNotice(pageKey: string, convId: string, notice: TurnNotice) {
  return patchConv(pageKey, convId, c => {
    const at = Math.max(0, c.messages.length - 1);
    const meta = { ...c.meta, [at]: { ...c.meta[at], notices: [...(c.meta[at]?.notices ?? []), notice] } };
    return { ...c, meta, updatedAt: Date.now() };
  });
}

/** Envoie un message (crée la conversation au besoin) puis lance la boucle d'outils. */
export async function sendMessage(text: string, toggles: ContextToggles, attachments: Attachment[] = []) {
  if (get().run) return;
  const pageKey = get().pageKey;
  const model = await getModel();
  const caps = await getModelCaps(model);
  let conv = activeConversation();
  if (!conv) conv = newConversation(model, CHAT_SYSTEM);
  const snap = snapshotContext();
  const built = await buildUserContent(text, snap, toggles, conv.sent, caps, attachments);
  built.warnings.forEach(w => toast(w, 'warning'));
  const userIndex = conv.messages.length;
  const updated: Conversation = {
    ...conv,
    title: conv.messages.length ? conv.title : titleFrom(text),
    model, updatedAt: Date.now(),
    messages: [...conv.messages, { role: 'user', content: built.content }],
    meta: { ...conv.meta, [userIndex]: { labels: built.labels } },
    sent: built.sent,
  };
  const convId = updated.id;
  set({ drafting: false });
  applyData(pageKey, await mutateConversations(pageKey, d => ({ ...d, activeId: convId, items: [updated, ...d.items.filter(c => c.id !== convId)] })));
  await runTurn(pageKey, convId);
}

/** Relance la génération quand le dernier message est resté sans réponse (erreur). */
export async function continueConversation() {
  const conv = activeConversation();
  if (!conv || get().run || !needsContinuation(conv.messages)) return;
  await runTurn(get().pageKey, conv.id);
}

async function runTurn(pageKey: string, convId: string) {
  const data = await loadConversations(pageKey);
  const conv = data.items.find(c => c.id === convId);
  if (!conv) return;
  const controller = new AbortController();
  set({ run: { pageKey, convId, controller, live: null, phases: {}, status: 'Claude réfléchit…' } });
  const setRun = (patch: Partial<RunState>) => { const r = get().run; if (r && r.convId === convId) set({ run: { ...r, ...patch } }); };
  let frame = 0; let pending: ContentBlock[] | null = null;
  const model = await getModel();
  try {
    await runAgent({
      messages: conv.messages, system: conv.system || CHAT_SYSTEM, tools: collectAgentTools(), model, signal: controller.signal,
      hooks: {
        onSnapshot: (content) => {
          pending = content;
          if (content === null) { if (frame) cancelAnimationFrame(frame); frame = 0; setRun({ live: null }); return; }
          if (!frame) frame = requestAnimationFrame(() => { frame = 0; setRun({ live: pending, status: 'Claude écrit…' }); });
        },
        onAppend: (messages) => patchConv(pageKey, convId, c => ({ ...c, messages, model, updatedAt: Date.now() })),
        onToolPhase: (id, phase) => {
          const r = get().run;
          if (r) setRun({ phases: { ...r.phases, [id]: phase }, status: phase === 'confirm' ? 'En attente de ta confirmation…' : phase === 'running' ? 'Outil en cours…' : r.status });
          if (phase === 'denied' || phase === 'error') void patchConv(pageKey, convId, c => ({ ...c, toolPhases: { ...c.toolPhases, [id]: phase } }));
        },
        onNotice: (text, level) => { void addNotice(pageKey, convId, { text, level }); },
      },
    });
  } catch (e) {
    if (!isAbortError(e)) await addNotice(pageKey, convId, { text: e instanceof Error ? e.message : String(e), level: 'error' });
  } finally {
    if (frame) cancelAnimationFrame(frame);
    if (get().run?.convId === convId) set({ run: null });
  }
}

export function stopGeneration() { get().run?.controller.abort(); }
