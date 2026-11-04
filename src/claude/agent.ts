// Boucle d'outils de Claude (streaming) : outils internes + outils des autres modules + outils MCP.
// Historique en ajout seul (réflexion préservée), confirmation avant toute action destructive/externe.
import Anthropic from '@anthropic-ai/sdk';
import { claudeTools } from '../ui/registry';
import { confirmAction } from '../ui/appState';
import { getClient, getModelCaps, humanizeClaudeError } from './api';
import { requestTuning } from './modelCaps';
import { getEffortSetting } from './models';
import { connectedTools, callToolRich } from './mcp';
import { INTERNAL_TOOL_NAMES, describeInternalCall } from './tools';
import { ToolNameRegistry, isValidToolName } from './toolNames';
import {
  DENIED_TEXT, INTERRUPTED_TEXT, confirmationMessage, invalidInputResult, needsConfirmation, normalizeInputSchema,
  stringifyResult, toolResultBlock, validateToolInput, type ToolMeta,
} from './agentUtil';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type ToolPhase = 'pending' | 'confirm' | 'running' | 'done' | 'error' | 'denied';

export interface AgentTool extends ToolMeta {
  description: string;
  input_schema: Record<string, unknown>;
  defer?: boolean;
  summarize?: (input: Record<string, unknown>) => string | null;
  run: (input: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<{ text: string; images?: { mediaType: string; base64: string }[]; isError?: boolean }>;
}

export interface AgentHooks {
  /** Message de l'assistant en cours de génération (null = terminé). */
  onSnapshot(content: ContentBlock[] | null): void;
  /** L'historique a été complété (à enregistrer). */
  onAppend(messages: MessageParam[]): Promise<void> | void;
  onToolPhase(id: string, phase: ToolPhase, detail?: string): void;
  onNotice(text: string, level: 'info' | 'warning' | 'error'): void;
}

export type AgentStop = 'end_turn' | 'aborted' | 'refusal' | 'max_tokens' | 'context' | 'max_iterations' | 'stop_sequence';

const MAX_ITERATIONS = 30;
const TOOL_SEARCH_THRESHOLD = 30;
const toolSearchUnsupported = new Set<string>();

/** Rassemble les outils disponibles : Prisme, autres modules (registry), MCP connectés. */
export function collectAgentTools(): AgentTool[] {
  const prisme: AgentTool[] = []; const modules: AgentTool[] = []; const seen = new Set<string>();
  for (const t of claudeTools) {
    if (seen.has(t.name) || !isValidToolName(t.name)) continue;
    seen.add(t.name);
    const source = INTERNAL_TOOL_NAMES.has(t.name) ? 'prisme' : 'module';
    const tool: AgentTool = {
      name: t.name, description: t.description, input_schema: t.input_schema, source,
      destructive: t.destructive, external: t.external,
      summarize: source === 'prisme' ? (i) => describeInternalCall(t.name, i) : undefined,
      run: async (input) => ({ text: stringifyResult(await t.run(input)) }),
    };
    (source === 'prisme' ? prisme : modules).push(tool);
  }
  modules.sort((a, b) => a.name.localeCompare(b.name));
  const names = new ToolNameRegistry();
  const mcp = connectedTools().sort((a, b) => a.server.localeCompare(b.server) || a.tool.name.localeCompare(b.tool.name));
  const mcpTools: AgentTool[] = mcp.map(({ server, tool }) => ({
    name: names.add(server, tool.name),
    description: `[Serveur MCP « ${server} »] ${tool.title && tool.title !== tool.name ? tool.title + ' — ' : ''}${tool.description ?? ''}`.trim(),
    input_schema: tool.inputSchema, source: 'mcp', server, originalName: tool.name,
    readOnly: tool.readOnly, destructive: tool.destructive, external: !tool.readOnly,
    run: async (input, { signal }) => {
      const r = await callToolRich(server, tool.name, input, { signal });
      return { text: r.text, images: r.images, isError: r.isError };
    },
  }));
  return [...prisme, ...modules, ...mcpTools];
}

function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Requête annulée.'), { name: 'AbortError' }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Requête annulée.'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

const isToolInputJsonError = (e: unknown) =>
  e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError) && /tool parameter JSON/i.test(e.message);

/** Exécute un tour complet (avec appels d'outils) à partir d'un historique se terminant par un message utilisateur. */
export async function runAgent(o: {
  messages: MessageParam[];
  system: string;
  tools: AgentTool[];
  model: string;
  signal: AbortSignal;
  hooks: AgentHooks;
}): Promise<{ stop: AgentStop }> {
  const { signal, hooks } = o;
  const client = await getClient();
  const caps = await getModelCaps(o.model);
  const tuning = requestTuning(caps, await getEffortSetting());
  const byName = new Map(o.tools.map(t => [t.name, t]));
  let history = [...o.messages];
  let jsonRetries = 0; let truncRetries = 0;
  let useToolSearch = caps.toolSearch && !toolSearchUnsupported.has(o.model) && o.tools.filter(t => t.source === 'mcp').length > TOOL_SEARCH_THRESHOLD;

  const append = async (msgs: MessageParam[]) => { history = [...history, ...msgs]; await hooks.onAppend(history); };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const apiTools: Anthropic.Beta.BetaToolUnion[] = o.tools.map(t => ({
      name: t.name, description: t.description, input_schema: normalizeInputSchema(t.input_schema),
      eager_input_streaming: true, ...(useToolSearch && t.source === 'mcp' ? { defer_loading: true } : {}),
    }));
    if (useToolSearch) apiTools.push({ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: o.model,
      max_tokens: Math.min(caps.maxOutput ?? 32_000, 64_000),
      system: o.system,
      messages: history,
      ...(apiTools.length ? { tools: apiTools } : {}),
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01', ...tuning.betas],
      fallbacks: 'default',
      ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
      ...(tuning.effort ? { output_config: { effort: tuning.effort } } : {}),
      stream: true,
    };

    let message: Anthropic.Beta.BetaMessage;
    let last: ContentBlock[] = [];
    try {
      const stream = client.beta.messages.stream(params, { signal });
      stream.on('streamEvent', (_e, snapshot) => { last = snapshot.content; hooks.onSnapshot(snapshot.content.slice()); });
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (e) {
      hooks.onSnapshot(null);
      if (signal.aborted) {
        // Conserve le texte déjà reçu (sans réflexion ni appel d'outil incomplets).
        const texts = last.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text' && !!b.text.trim()).map(b => ({ type: 'text' as const, text: b.text }));
        if (texts.length) await append([{ role: 'assistant', content: texts }]);
        hooks.onNotice('Réponse interrompue.', 'info');
        return { stop: 'aborted' };
      }
      if (isToolInputJsonError(e) && jsonRetries++ < 2) continue;
      if (useToolSearch && e instanceof Anthropic.BadRequestError && /tool_search|defer_loading/i.test(e.message)) {
        toolSearchUnsupported.add(o.model); useToolSearch = false; continue;
      }
      throw humanizeClaudeError(e);
    }
    hooks.onSnapshot(null);

    for (const b of message.content) {
      if (b.type === 'fallback') hooks.onNotice(`${b.from.model} a décliné cette demande ; ${b.to.model} a répondu à sa place.`, 'info');
    }
    const content = message.content as unknown as ContentBlockParam[];
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    const stop = message.stop_reason;

    if (stop === 'refusal') {
      const kept = content.filter(b => b.type !== 'tool_use' && b.type !== 'server_tool_use');
      if (kept.some(b => b.type === 'text' && b.text.trim())) await append([{ role: 'assistant', content: kept }]);
      const cat = message.stop_details?.category;
      hooks.onNotice(`Claude a refusé de poursuivre${cat ? ` (catégorie : ${cat})` : ''}. Reformule ta demande.`, 'warning');
      return { stop: 'refusal' };
    }

    if (!content.length) { hooks.onNotice('Réponse vide.', 'warning'); return { stop: 'end_turn' }; }
    await append([{ role: 'assistant', content }]);

    if (stop === 'pause_turn') continue;
    if (stop === 'model_context_window_exceeded') {
      if (toolUses.length) await append([{ role: 'user', content: toolUses.map(t => toolResultBlock(t.id, 'Non exécuté : la conversation a atteint la taille maximale.', { isError: true })) }]);
      hooks.onNotice('La conversation est trop longue : démarre une nouvelle conversation.', 'error');
      return { stop: 'context' };
    }
    if (!toolUses.length) {
      if (stop === 'max_tokens') { hooks.onNotice('Réponse tronquée (longueur maximale atteinte). Demande « continue » pour la suite.', 'warning'); return { stop: 'max_tokens' }; }
      return { stop: stop === 'stop_sequence' ? 'stop_sequence' : 'end_turn' };
    }
    if (stop === 'max_tokens') {
      // Entrée d'outil tronquée : on ne l'exécute pas.
      for (const t of toolUses) hooks.onToolPhase(t.id, 'error', 'Entrée tronquée');
      await append([{ role: 'user', content: toolUses.map(t => toolResultBlock(t.id, 'Non exécuté : la demande d\'outil a été tronquée (longueur maximale atteinte). Réessaie avec une entrée plus courte, en plusieurs fois si besoin.', { isError: true })) }]);
      if (truncRetries++ < 1) continue;
      hooks.onNotice('Réponse tronquée (longueur maximale atteinte).', 'warning');
      return { stop: 'max_tokens' };
    }

    const results: ToolResult[] = [];
    for (const tu of toolUses) results.push(await executeTool(tu, byName, signal, hooks));
    await append([{ role: 'user', content: results }]);
    if (signal.aborted) { hooks.onNotice('Interrompu.', 'info'); return { stop: 'aborted' }; }
  }
  hooks.onNotice('Nombre maximal d\'étapes atteint pour ce message.', 'warning');
  return { stop: 'max_iterations' };
}

async function executeTool(tu: Anthropic.Beta.BetaToolUseBlock, byName: Map<string, AgentTool>, signal: AbortSignal, hooks: AgentHooks): Promise<ToolResult> {
  if (signal.aborted) { hooks.onToolPhase(tu.id, 'denied', 'Interrompu'); return toolResultBlock(tu.id, INTERRUPTED_TEXT, { isError: true }); }
  const tool = byName.get(tu.name);
  if (!tool) { hooks.onToolPhase(tu.id, 'error', 'Outil inconnu'); return toolResultBlock(tu.id, `Outil inconnu ou indisponible : ${tu.name}.`, { isError: true }); }
  const input = (tu.input && typeof tu.input === 'object' ? tu.input : {}) as Record<string, unknown>;
  const check = validateToolInput(tu.input, tool.input_schema);
  if (!check.ok) { hooks.onToolPhase(tu.id, 'error', 'Entrée invalide'); return invalidInputResult(tu.id, tu.input, check.error); }
  if (needsConfirmation(tool)) {
    hooks.onToolPhase(tu.id, 'confirm');
    let ok = false;
    try { ok = await confirmAction(confirmationMessage(tool, input, tool.summarize?.(input)), { danger: !!tool.destructive, confirmLabel: 'Autoriser' }); } catch { ok = false; }
    if (!ok || signal.aborted) { hooks.onToolPhase(tu.id, 'denied'); return toolResultBlock(tu.id, signal.aborted ? INTERRUPTED_TEXT : DENIED_TEXT, { isError: true }); }
  }
  hooks.onToolPhase(tu.id, 'running');
  try {
    const out = await withAbort(tool.run(input, { signal }), signal);
    hooks.onToolPhase(tu.id, out.isError ? 'error' : 'done');
    return toolResultBlock(tu.id, out.text, { isError: out.isError, images: out.images });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    hooks.onToolPhase(tu.id, signal.aborted ? 'denied' : 'error', msg);
    return toolResultBlock(tu.id, signal.aborted ? INTERRUPTED_TEXT : `Erreur : ${msg}`, { isError: true });
  }
}
