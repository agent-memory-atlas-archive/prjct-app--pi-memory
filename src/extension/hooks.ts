import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { EvidenceRef } from '../contracts/evidence.ts';
import { hostEvidence, MemoryEngine } from '../engine.ts';
import { redactSecrets } from '../security/redact.ts';

export type MemorySession = Readonly<{
  engine?: Promise<MemoryEngine>;
  ctx?: ExtensionContext;
  prompt: string;
  evidence: ReadonlyMap<string, EvidenceRef>;
}>;

const textContent = (content: readonly unknown[]): string => content.flatMap(part => {
  if (!part || typeof part !== 'object') return [];
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' ? [text] : [];
}).join('\n');

const clip = (text: string, max = 2048): string => text.length <= max ? text : `${text.slice(0, max)}…`;

// Score a candidate must reach before it is injected into the system prompt
// unasked. Low enough to let a solid lexical-only match through, high enough to
// keep a single weak signal out.
export const DEFAULT_RECALL_THRESHOLD = 0.055;

export const installMemoryHooks = (pi: ExtensionAPI, options: { home?: string; recallThreshold?: number } = {}) => {
  const recallThreshold = options.recallThreshold ?? DEFAULT_RECALL_THRESHOLD;
  const slot: { current: MemorySession } = { current: { prompt: '', evidence: new Map() } };
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

  pi.on('session_start', async (_event, ctx) => {
    set({ ctx, prompt: '', evidence: new Map() });
  });

  pi.on('before_agent_start', async (event, ctx) => {
    set({ ctx, prompt: event.prompt });
    const recalled = await engine().then(memory => memory.search({ queries: [event.prompt], limit: 4, maxBytes: 2200, dense: false, scoreThreshold: recallThreshold })).catch(() => undefined);
    const highConfidence = recalled?.items.slice(0, 4) ?? [];
    const memoryBlock = highConfidence.length
      ? `\n\nRetained memory candidates for this turn (the active agent must rerank and verify them):\n${highConfidence.map(item =>
        `- ${item.id} [${item.standing ?? 'source'}/${item.provenance}; ${item.reason.join('+')}]: ${clip(item.statement, 420)}`).join('\n')}\nUse memory_context to inspect or expand the search; ignore irrelevant candidates.`
      : '';
    return { systemPrompt: `${event.systemPrompt}\n\nPi-memory rules: The current Pi agent is the only reasoning engine. Use memory_context for bounded retrieval and memory_record for selective durable knowledge. Never store routine reads, generic summaries, secrets, credentials, or unsupported claims.${memoryBlock}` };
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

  pi.on('session_shutdown', async () => {
    const pending = get().engine;
    set({ engine: undefined, ctx: undefined, evidence: new Map(), prompt: '' });
    if (pending) await (await pending).dispose().catch(() => undefined);
  });

  return { engine, stagedEvidence: () => get().evidence, currentPrompt: () => get().prompt };
};
