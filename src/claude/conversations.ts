// Conversations Claude rattachées à chaque page (kv `claude:conv:<pageId>`, « global » hors page)
// et dérivation du fil affiché à partir de l'historique API (en ajout seul).
import type Anthropic from '@anthropic-ai/sdk';
import { repo, uid } from '../db/store';
import { isContextText, type SentState } from './context';
import type { ToolPhase } from './agent';

type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface TurnNotice { text: string; level: 'info' | 'warning' | 'error' }
export interface TurnMeta { labels?: string[]; notices?: TurnNotice[] }

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  /** Consigne système figée à la création (préfixe stable). */
  system: string;
  messages: MessageParam[];
  /** Métadonnées d'affichage, indexées par position dans `messages`. */
  meta: Record<number, TurnMeta>;
  /** États des appels d'outils (refusé, erreur…), par id de tool_use. */
  toolPhases: Record<string, ToolPhase>;
  sent: SentState;
}

export interface PageConversations { v: 1; activeId: string | null; items: Conversation[] }

export const GLOBAL_KEY = 'global';
export const convKey = (pageKey: string) => `claude:conv:${pageKey}`;
const MAX_CONVERSATIONS = 40;

export async function loadConversations(pageKey: string): Promise<PageConversations> {
  const raw = await repo.kvGet<PageConversations>(convKey(pageKey)).catch(() => undefined);
  if (!raw || raw.v !== 1 || !Array.isArray(raw.items)) return { v: 1, activeId: null, items: [] };
  return raw;
}

const queues = new Map<string, Promise<unknown>>();
/** Modifie et enregistre les conversations d'une page (écritures sérialisées par page). */
export function mutateConversations(pageKey: string, fn: (d: PageConversations) => PageConversations): Promise<PageConversations> {
  const prev = queues.get(pageKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const data = fn(await loadConversations(pageKey));
    const items = [...data.items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
    const out: PageConversations = { v: 1, activeId: items.some(c => c.id === data.activeId) ? data.activeId : null, items };
    await repo.kvSet(convKey(pageKey), out);
    return out;
  });
  queues.set(pageKey, next);
  return next;
}

export function newConversation(model: string, system: string): Conversation {
  const now = Date.now();
  return { id: uid(), title: 'Nouvelle conversation', createdAt: now, updatedAt: now, model, system, messages: [], meta: {}, toolPhases: {}, sent: { files: [] } };
}

/** Titre court tiré du premier message (« Résume cette page et propose… »). */
export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return 'Nouvelle conversation';
  return one.length > 60 ? one.slice(0, 57).replace(/\s+\S*$/, '') + '…' : one;
}

// ───────────────────────────── Fil affiché (pur) ─────────────────────────────

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result?: { text: string; isError: boolean; images: number }; phase: ToolPhase }
  | { kind: 'search'; query: string }
  | { kind: 'notice'; notice: TurnNotice };

export type ThreadItem =
  | { kind: 'user'; index: number; text: string; labels: string[]; attachments: number }
  | { kind: 'assistant'; index: number; parts: AssistantPart[] };

const resultText = (c: Anthropic.Beta.BetaToolResultBlockParam['content']): { text: string; images: number } => {
  if (typeof c === 'string') return { text: c, images: 0 };
  let text = ''; let images = 0;
  for (const b of c ?? []) { if (b.type === 'text') text += (text ? '\n' : '') + b.text; else if (b.type === 'image') images++; }
  return { text, images };
};

/** Historique API → éléments du fil (tours de l'assistant fusionnés, résultats rattachés aux appels). */
export function buildThread(conv: Pick<Conversation, 'messages' | 'meta' | 'toolPhases'>): ThreadItem[] {
  const items: ThreadItem[] = [];
  const tools = new Map<string, Extract<AssistantPart, { kind: 'tool' }>>();
  const currentAssistant = (index: number) => {
    const last = items[items.length - 1];
    if (last?.kind === 'assistant') return last;
    const a: ThreadItem = { kind: 'assistant', index, parts: [] };
    items.push(a);
    return a;
  };
  conv.messages.forEach((m, index) => {
    const meta = conv.meta[index];
    if (m.role === 'user') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
      const results = blocks.filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === 'tool_result');
      if (results.length && results.length === blocks.length) {
        for (const r of results) {
          const t = tools.get(r.tool_use_id);
          if (!t) continue;
          const rt = resultText(r.content);
          t.result = { text: rt.text, isError: !!r.is_error, images: rt.images };
          if (!conv.toolPhases[t.id]) t.phase = r.is_error ? 'error' : 'done';
        }
      } else {
        const texts = blocks.filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text' && !isContextText(b.text));
        const attachments = blocks.filter(b => b.type === 'image' || b.type === 'document').length;
        items.push({ kind: 'user', index, text: texts.map(t => t.text).join('\n\n'), labels: meta?.labels ?? [], attachments });
      }
    } else if (m.role === 'assistant') {
      const a = currentAssistant(index) as Extract<ThreadItem, { kind: 'assistant' }>;
      const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) a.parts.push({ kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking.trim()) a.parts.push({ kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') {
          const part: Extract<AssistantPart, { kind: 'tool' }> = { kind: 'tool', id: b.id, name: b.name, input: b.input, phase: conv.toolPhases[b.id] ?? 'pending' };
          tools.set(b.id, part);
          a.parts.push(part);
        } else if (b.type === 'server_tool_use') {
          const q = (b.input as { query?: unknown } | undefined)?.query;
          a.parts.push({ kind: 'search', query: typeof q === 'string' ? q : '' });
        }
      }
    }
    if (meta?.notices?.length) {
      const target = items[items.length - 1];
      if (target?.kind === 'assistant') target.parts.push(...meta.notices.map(n => ({ kind: 'notice' as const, notice: n })));
      else items.push({ kind: 'assistant', index, parts: meta.notices.map(n => ({ kind: 'notice' as const, notice: n })) });
    }
  });
  return items;
}

/** Texte de la réponse d'un tour de l'assistant (pour « Copier » / « Insérer »). */
export const answerText = (item: Extract<ThreadItem, { kind: 'assistant' }>) =>
  item.parts.filter((p): p is Extract<AssistantPart, { kind: 'text' }> => p.kind === 'text').map(p => p.text).join('\n\n').trim();

/** Le dernier tour est-il resté sans réponse (erreur réseau…) ? */
export function needsContinuation(messages: MessageParam[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'user';
}
