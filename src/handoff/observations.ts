import { estimateHandoffTokens } from './select.ts';
import { toolCallIds, type HandoffMessage } from './turns.ts';

/**
 * Observation masking. Old tool outputs were 70-86% of every request in real
 * sessions and were re-sent on each of ~35 calls per prompt. Outputs older than
 * the newest `keepRounds` tool rounds are replaced with short stubs that name
 * what was elided and how to get it back. Calls, results and all user/assistant
 * text are kept, so call/result pairs stay atomic.
 *
 * Masking is a pure function of (messages, frontier). The frontier only moves in
 * batches of at least `advanceTokens`. The 24k default amortizes prefix
 * rewrites across many calls rather than trading fewer raw tokens for higher
 * uncached cost. The serialized prefix stays identical between advances.
 */
export type ObservationPolicy = Readonly<{
  enabled: boolean;
  /** Newest tool rounds whose outputs are never masked. */
  keepRounds: number;
  /** Outputs at or below this estimate are left intact. */
  minTokens: number;
  /** Stale unmasked tokens required before the frontier advances. */
  advanceTokens: number;
}>;

export const DEFAULT_OBSERVATION_POLICY: ObservationPolicy = {
  enabled: true, keepRounds: 8, minTokens: 300, advanceTokens: 24_000,
};

type Call = Readonly<{ name: string; args: Record<string, unknown>; owner: number }>;

const isResult = (message: HandoffMessage): boolean => message.role === 'toolResult' || message.role === 'tool';

const callsOf = (messages: readonly HandoffMessage[]): ReadonlyMap<string, Call> => new Map(messages.flatMap((message, owner) => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return (message.content as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }[]).flatMap(block =>
    block?.type === 'toolCall' && typeof block.id === 'string'
      ? [[block.id, {
        name: typeof block.name === 'string' ? block.name : 'tool',
        args: block.arguments && typeof block.arguments === 'object' ? block.arguments as Record<string, unknown> : {},
        owner,
      }] as const]
      : []);
}));

const textOf = (message: HandoffMessage): string => typeof message.content === 'string'
  ? message.content
  : Array.isArray(message.content)
    ? (message.content as { type?: unknown; text?: unknown }[])
      .flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
    : '';

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}…`;

const lines = (text: string): string[] => text.replace(/\n+$/, '').split('\n');

const stubFor = (message: HandoffMessage, call: Call | undefined, tokens: number): string => {
  const text = textOf(message);
  const all = lines(text);
  const name = call?.name ?? 'tool';
  const args = call?.args ?? {};
  const head = `[pi-memory: elided stale ${name} output, ~${tokens} tokens, ${all.length} lines`;
  if (name === 'read') {
    const range = [args.offset === undefined ? '' : ` offset=${String(args.offset)}`, args.limit === undefined ? '' : ` limit=${String(args.limit)}`].join('');
    return `${head}, of ${clip(String(args.path ?? '?'), 300)}${range}. Read it again if you need the content.]`;
  }
  if (name === 'bash') {
    const tail = clip(all.slice(-15).join('\n'), 1_200);
    return `${head}, for: ${clip(String(args.command ?? '?'), 300)}. Last lines:]\n${tail}`;
  }
  if (name === 'grep' || name === 'find' || name === 'ls') {
    const first = clip(all.slice(0, 10).join('\n'), 1_000);
    return `${head}, for ${clip(JSON.stringify(args), 300)}. First lines:]\n${first}`;
  }
  return `${head}. Run the tool again if you need it.]`;
};

/** Message index of the assistant call that owns each masked-eligible result, with its size. */
const eligible = (messages: readonly HandoffMessage[], calls: ReadonlyMap<string, Call>, policy: ObservationPolicy) =>
  messages.flatMap((message, index) => {
    if (!isResult(message) || !message.toolCallId) return [];
    if (Array.isArray(message.content) && message.content.some(block => !block || typeof block !== 'object'
      || (block as { type?: unknown }).type !== 'text')) return [];
    const call = calls.get(message.toolCallId);
    if (!call) return [];
    const tokens = estimateHandoffTokens(message);
    return tokens > policy.minTokens ? [{ index, owner: call.owner, tokens }] : [];
  });

/** Index of the first assistant message inside the protected keep window. */
export const keepBoundary = (messages: readonly HandoffMessage[], policy: ObservationPolicy): number => {
  const owners = messages.flatMap((message, index) => message.role === 'assistant' && toolCallIds(message).length ? [index] : []);
  return owners.length > policy.keepRounds ? owners[owners.length - policy.keepRounds]! : 0;
};

/**
 * Next frontier: stays put until the stale, still-unmasked outputs behind the
 * keep window reach `advanceTokens`, then jumps to the keep boundary at once.
 * `force` flushes any pending output: the prefix is already being rewritten.
 */
export const nextObservationFrontier = (messages: readonly HandoffMessage[], frontier: number,
  policy: ObservationPolicy, force = false): number => {
  if (!policy.enabled) return 0;
  const boundary = keepBoundary(messages, policy);
  if (boundary <= frontier) return Math.min(frontier, boundary);
  const calls = callsOf(messages);
  const pending = eligible(messages, calls, policy)
    .filter(item => item.owner >= frontier && item.owner < boundary)
    .reduce((sum, item) => sum + item.tokens, 0);
  return pending >= (force ? 1 : policy.advanceTokens) ? boundary : frontier;
};

/**
 * The agent's own arguments are context too: a file written in full, a long
 * edit, a script pasted into bash. Once stale they are replaced like outputs;
 * the file is on disk and the command already ran. The self_compact note is
 * always stubbed: it comes back byte for byte as the next message.
 */
const ARG_STUB_CHARS = 1_200;
const stubArgs = (name: string, args: Record<string, unknown>, stale: boolean): Record<string, unknown> | undefined => {
  const size = JSON.stringify(args).length;
  if (name === 'self_compact' && typeof args.note_to_self === 'string') {
    return { note_to_self: `[pi-memory: note of ${args.note_to_self.length} chars, delivered as the handoff message]` };
  }
  if (!stale || size <= ARG_STUB_CHARS) return undefined;
  if (name === 'write') return { path: args.path, content: `[pi-memory: elided ${String(args.content ?? '').length} chars written; the file is on disk]` };
  if (name === 'edit') return { path: args.path, edits: `[pi-memory: elided ${size} chars of edits; read the file for its current content]` };
  if (name === 'bash' && typeof args.command === 'string') return { ...args, command: `${args.command.slice(0, 300)}… [pi-memory: elided ${args.command.length - 300} chars of command]` };
  return undefined;
};

const maskArgs = (message: HandoffMessage, stale: boolean): HandoffMessage => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
  const blocks = message.content as { type?: unknown; name?: unknown; arguments?: unknown }[];
  const content = blocks.map(block => {
    if (block?.type !== 'toolCall' || typeof block.name !== 'string' || !block.arguments || typeof block.arguments !== 'object') return block;
    const stub = stubArgs(block.name, block.arguments as Record<string, unknown>, stale);
    return stub ? { ...block, arguments: stub } : block;
  });
  return content.some((block, index) => block !== blocks[index]) ? { ...message, content } as HandoffMessage : message;
};

/** Same length and order as the input; unchanged messages keep their identity. */
export const maskObservations = (messages: readonly HandoffMessage[], frontier: number,
  policy: ObservationPolicy): Readonly<{ messages: readonly HandoffMessage[]; maskedTokens: number; masked: number }> => {
  if (!policy.enabled) return { messages, maskedTokens: 0, masked: 0 };
  if (frontier <= 0) {
    const notes = messages.map(message => maskArgs(message, false));
    return notes.every((message, index) => message === messages[index])
      ? { messages, maskedTokens: 0, masked: 0 }
      : { messages: notes, maskedTokens: 0, masked: 0 };
  }
  const calls = callsOf(messages);
  const targets = new Map(eligible(messages, calls, policy).filter(item => item.owner < frontier).map(item => [item.index, item.tokens]));
  const stats = { maskedTokens: 0, masked: 0 };
  const view = messages.map((message, index) => {
    if (message.role === 'assistant') {
      const masked = maskArgs(message, index < frontier);
      if (masked !== message) {
        const saved = estimateHandoffTokens(message) - estimateHandoffTokens(masked);
        stats.maskedTokens += Math.max(0, saved);
        stats.masked += 1;
      }
      return masked;
    }
    const tokens = targets.get(index);
    if (tokens === undefined) return message;
    const text = stubFor(message, calls.get(message.toolCallId!), tokens);
    const replacement = { ...message, content: [{ type: 'text', text }] } as HandoffMessage;
    const saved = tokens - estimateHandoffTokens(replacement);
    if (saved <= 0) return message;
    stats.maskedTokens += saved;
    stats.masked += 1;
    return replacement;
  });
  return { messages: view, ...stats };
};
