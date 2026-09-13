import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { EvidenceRef } from '../contracts/evidence.ts';
import { hostEvidence, MemoryEngine } from '../engine.ts';
import { federatedSearch } from '../retrieval/federated.ts';
import { redactSecrets } from '../security/redact.ts';
import { discoverTeams } from '../sources/discovery.ts';
import { prjctHomeFor } from '../workspace/project-identity.ts';

export type MemorySession = Readonly<{
  engine?: Promise<MemoryEngine>;
  readable?: Promise<readonly MemoryEngine[]>;
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

export type MemorySearch = (request: Parameters<typeof federatedSearch>[1]) => ReturnType<typeof federatedSearch>;

// Score a candidate must reach before it is injected into the system prompt
// unasked. Low enough to let a solid lexical-only match through, high enough to
// keep a single weak signal out.
export const DEFAULT_RECALL_THRESHOLD = 0.055;

export const installMemoryHooks = (pi: ExtensionAPI, options: { home?: string; recallThreshold?: number; federate?: boolean } = {}) => {
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

  /**
   * Every scope this session may read: the project it is working in, each team
   * registered on this machine, and the shared scope. Retrieval filters on
   * scopeId, so without this the agent could only ever see the project — team
   * knowledge would be indexed and never returned.
   *
   * Opened once per session and reused. A scope that will not open is left out
   * rather than failing the search.
   */
  const readable = async (): Promise<readonly MemoryEngine[]> => {
    const current = get();
    if (current.readable) return current.readable;
    const project = await engine();
    if (options.federate === false) return [project];
    const sessionId = current.ctx!.sessionManager.getSessionId();
    const home = prjctHomeFor(options.home);
    const scoped = options.home === undefined ? {} : { home: options.home };
    const pending = (async (): Promise<readonly MemoryEngine[]> => {
      const teams = await discoverTeams(home).catch(() => []);
      const others = await Promise.all([
        MemoryEngine.forShared(sessionId, scoped).catch(() => undefined),
        ...teams.map(team => MemoryEngine.forScope('team', team.id, sessionId, scoped).catch(() => undefined)),
      ]);
      return [project, ...others.flatMap(found => found ?? [])];
    })();
    set({ readable: pending });
    return pending;
  };

  const search: MemorySearch = async request => federatedSearch(await readable(), request);

  pi.on('session_start', async (_event, ctx) => {
    set({ ctx, prompt: '', evidence: new Map() });
  });

  pi.on('before_agent_start', async (event, ctx) => {
    set({ ctx, prompt: event.prompt });
    const recalled = await search({ queries: [event.prompt], limit: 4, maxBytes: 2200, dense: false, scoreThreshold: recallThreshold })
      .catch(() => undefined);
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
    const { engine: pending, readable: opened } = get();
    set({ engine: undefined, readable: undefined, ctx: undefined, evidence: new Map(), prompt: '' });
    // The project engine is one of the readable ones; dispose the set, not both.
    const engines = await opened?.catch(() => []) ?? (pending ? [await pending] : []);
    for (const memory of engines) await memory.dispose().catch(() => undefined);
    if (!engines.length && pending) await (await pending).dispose().catch(() => undefined);
  });

  return { engine, readable, search, stagedEvidence: () => get().evidence, currentPrompt: () => get().prompt };
};
