import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { EvidenceRef } from '../contracts/evidence.ts';
import { hostEvidence, MemoryEngine } from '../engine.ts';
import { createHandoffController, installHandoffHooks } from '../handoff/hooks.ts';
import type { HandoffBudget } from '../handoff/select.ts';
import { federatedSearch } from '../retrieval/federated.ts';
import { redactSecrets } from '../security/redact.ts';

export type MemorySession = Readonly<{
  engine?: Promise<MemoryEngine>;
  readable?: Promise<readonly MemoryEngine[]>;
  ctx?: ExtensionContext;
  prompt: string;
  evidence: ReadonlyMap<string, EvidenceRef>;
  /** Last context size seen, to turn a running total into a per-turn delta. */
  contextTokens: number;
}>;

const textContent = (content: readonly unknown[]): string => content.flatMap(part => {
  if (!part || typeof part !== 'object') return [];
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' ? [text] : [];
}).join('\n');

const clip = (text: string, max = 2048): string => text.length <= max ? text : `${text.slice(0, max)}…`;

export type MemorySearch = (request: Parameters<typeof federatedSearch>[1]) => ReturnType<typeof federatedSearch>;

// The shared evidence-coverage gate runs before ranking for both lookup and
// automatic recall. Do not confuse a rank-fusion score with answerability:
// an additional positive floor discarded supported Spanish/qualified matches.
export const DEFAULT_RECALL_THRESHOLD = 0;

export const installMemoryHooks = (pi: ExtensionAPI, options: {
  home?: string; recallThreshold?: number; federate?: boolean;
  handoff?: HandoffBudget;
  /** Called after each turn is counted, so the caller can sync when due. */
  onActivity?: (project: MemoryEngine) => Promise<void> | void;
} = {}) => {
  const recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;
  const onActivity = options.onActivity;
  const slot: { current: MemorySession } = { current: { prompt: '', evidence: new Map(), contextTokens: 0 } };
  const get = (): MemorySession => slot.current;
  const set = (update: Partial<MemorySession>): MemorySession => (slot.current = { ...slot.current, ...update });
  const engine = async (): Promise<MemoryEngine> => {
    const current = get();
    if (current.engine) return current.engine;
    if (!current.ctx) throw new Error('Memory session has not started.');
    const pending = MemoryEngine.forProject(current.ctx.cwd, current.ctx.sessionManager.getSessionId(),
      options.home === undefined ? {} : { home: options.home });
    set({ engine: pending });
    return pending;
  };

  /** The active project's memory only. Team/shared databases are not readable. */
  const readable = async (): Promise<readonly MemoryEngine[]> => {
    const current = get();
    if (current.readable) return current.readable;
    const pending = engine().then(project => [project] as const);
    set({ readable: pending });
    return pending;
  };

  const search: MemorySearch = async request => federatedSearch(await readable(), request);
  const handoff = createHandoffController({ engine, ...(options.handoff === undefined ? {} : { budget: options.handoff }) });

  /**
   * Records what this turn cost. The host reports the size of the whole
   * context, not the growth, so the delta is taken here; a context that shrank
   * has been compacted, and its new size is the growth since.
   */
  const countTurn = async (ctx: ExtensionContext): Promise<void> => {
    const project = await engine();
    const seen = ctx.getContextUsage?.()?.tokens ?? null;
    const previous = get().contextTokens;
    const grown = seen === null ? 0 : seen > previous ? seen - previous : seen;
    if (seen !== null) set({ contextTokens: seen });
    project.projection.recordActivity({ turns: 1, tokens: grown });
    await onActivity?.(project);
  };

  pi.on('session_start', async (_event, ctx) => {
    handoff.clear();
    if (ctx.model) handoff.observeModel(ctx.cwd, ctx.sessionManager.getSessionId(), ctx.model);
    const previous = get();
    if (previous.ctx && previous.ctx.cwd !== ctx.cwd) {
      const opened = await previous.readable?.catch(() => []) ?? [];
      const pending = previous.engine ? [await previous.engine.catch(() => undefined)] : [];
      for (const memory of [...opened, ...pending]) await memory?.dispose().catch(() => undefined);
    }
    set({ engine: undefined, readable: undefined, ctx, prompt: '', evidence: new Map(), contextTokens: 0 });
  });

  pi.on('before_agent_start', async (event, ctx) => {
    set({ ctx, prompt: event.prompt });
    await countTurn(ctx).catch(() => undefined);
    const recalled = await search({ queries: [event.prompt], limit: 4, maxBytes: 1500, dense: false, scoreThreshold: recallThreshold, namespaces: ['memory', 'memory.topic'] })
      .catch(() => undefined);
    const highConfidence = recalled?.items.slice(0, 4) ?? [];
    const memoryBlock = highConfidence.length
      ? `\n\nRetained memory candidates for this turn (the active agent must rerank and verify them):\n${highConfidence.map(item =>
        `- ${item.scopeKind}/${item.scopeId}/${item.namespace}:${item.id} [${item.standing ?? 'source'}/${item.provenance}; ${item.reason.join('+')}; observed ${item.observedAt ?? 'unknown'}; validity ${item.validAt ?? '?'} .. ${item.invalidAt ?? '?'}]: ${item.statement}`).join('\n')}\n${recalled?.gaps.length ? `Limitations: ${recalled.gaps.join(' ')}\n` : ''}Use memory_context to inspect or expand the search; ignore irrelevant candidates. Observation dates do not prove current validity; verify historical proposals against current sources.`
      : recalled?.status === 'abstained'
        ? '\n\nRetained memory abstained: insufficient evidence for this turn. No memory candidates were injected; this is not proof that the requested fact does not exist.'
        : '';
    return { systemPrompt: `${event.systemPrompt}\n\nPi-memory rules: This interactive agent retrieves and records; it does not start the memory daemon or run background analysis. Use memory_context for bounded retrieval and memory_record for selective durable knowledge. Never store routine reads, generic summaries, secrets, credentials, or unsupported claims.${memoryBlock}` };
  });

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === 'memory_context' || event.toolName === 'memory_record') return;
    const raw = textContent(event.content as readonly unknown[]);
    const excerpt = clip(redactSecrets(`${event.toolName} ${event.isError ? 'failed' : 'succeeded'}\n${raw || '(no textual output)'}`));
    const evidence = hostEvidence({ excerpt, actorId: ctx.sessionManager.getSessionId(), sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId });
    const entries = [...get().evidence.entries(), [evidence.id, evidence] as const].slice(-64);
    set({ evidence: new Map(entries) });
    return { content: [...event.content, { type: 'text', text: `[pi-memory evidence: ${evidence.id}]` }] };
  });

  installHandoffHooks(pi, handoff, engine);

  pi.on('session_shutdown', async () => {
    const { engine: pending, readable: opened } = get();
    handoff.clear();
    set({ engine: undefined, readable: undefined, ctx: undefined, evidence: new Map(), prompt: '', contextTokens: 0 });
    // The project engine is one of the readable ones; dispose the set, not both.
    const engines = await opened?.catch(() => []) ?? (pending ? [await pending] : []);
    for (const memory of engines) await memory.dispose().catch(() => undefined);
    if (!engines.length && pending) await (await pending).dispose().catch(() => undefined);
  });

  return { engine, readable, search, stagedEvidence: () => get().evidence, currentPrompt: () => get().prompt, handoff };
};
