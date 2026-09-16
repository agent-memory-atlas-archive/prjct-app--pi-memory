import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type { OperationalCheckpoint } from './checkpoint.ts';
import { renderCheckpoint } from './checkpoint.ts';
import { groupTurns, turnIsComplete, type HandoffMessage, type Turn } from './turns.ts';

export type HandoffBudget = Readonly<{
  maxTokens: number;
  maxBytes: number;
  maxMessages: number;
  /** Public Pi has no tool-schema size accessor, so callers reserve it explicitly. */
  toolSchemaReserveTokens: number;
}>;

export type HandoffOverhead = Readonly<{
  systemTokens: number;
  systemBytes: number;
}>;

export const DEFAULT_HANDOFF_BUDGET: HandoffBudget = {
  maxTokens: 8_000,
  maxBytes: 65_536,
  maxMessages: 48,
  toolSchemaReserveTokens: 1_500,
};

const NO_OVERHEAD: HandoffOverhead = { systemTokens: 0, systemBytes: 0 };

export type HandoffResult = Readonly<{
  ok: true;
  messages: readonly HandoffMessage[];
  preTokens: number;
  postTokens: number;
  preMessageTokens: number;
  postMessageTokens: number;
  systemTokens: number;
  toolSchemaReserveTokens: number;
  preBytes: number;
  postBytes: number;
  systemBytes: number;
  omittedTurns: number;
  reason: string;
}> | Readonly<{
  ok: false;
  instruction: string;
  preTokens: number;
  preBytes: number;
  systemTokens: number;
  toolSchemaReserveTokens: number;
}>;

const messageBytes = (message: HandoffMessage): number => Buffer.byteLength(JSON.stringify(message), 'utf8');

const assertBudget = (budget: HandoffBudget, overhead: HandoffOverhead): void => {
  const positive = [budget.maxTokens, budget.maxBytes, budget.maxMessages];
  if (positive.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Handoff limits must be positive safe integers.');
  const reserves = [budget.toolSchemaReserveTokens, overhead.systemTokens, overhead.systemBytes];
  if (reserves.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Handoff overhead must be non-negative safe integers.');
};

export const estimateHandoffTokens = (message: HandoffMessage): number => {
  try {
    return estimateTokens(message as never);
  } catch {
    return Math.max(1, Math.ceil(messageBytes(message) / 4));
  }
};

const packCost = (messages: readonly HandoffMessage[], budget: HandoffBudget, overhead: HandoffOverhead): {
  tokens: number; messageTokens: number; bytes: number;
} => {
  const messageTokens = messages.reduce((sum, message) => sum + estimateHandoffTokens(message), 0);
  return {
    messageTokens,
    tokens: overhead.systemTokens + budget.toolSchemaReserveTokens + messageTokens,
    bytes: overhead.systemBytes + messages.reduce((sum, message) => sum + messageBytes(message), 0),
  };
};

const checkpointMessage = (checkpoint: OperationalCheckpoint): HandoffMessage => ({
  role: 'user',
  content: [{ type: 'text', text: `Operational checkpoint (not a transcript):\n${renderCheckpoint(checkpoint)}` }],
});

// Pi 0.85.1 exposes applied compaction and branch summaries as AgentMessage
// roles. Only the newest is a fallback continuity checkpoint; a newer explicit
// checkpoint wins so stale summaries cannot displace current operator intent.
const isPiSummary = (message: HandoffMessage): boolean =>
  message.role === 'compactionSummary' || message.role === 'branchSummary';
const isRegenerableRecall = (message: HandoffMessage): boolean =>
  (message as HandoffMessage & { customType?: string }).customType === 'pi-memory-recall';

const continuityPrefix = (
  messages: readonly HandoffMessage[], checkpoint: OperationalCheckpoint | undefined,
): readonly HandoffMessage[] => {
  const latestSummary = messages.filter(isPiSummary).at(-1);
  if (!latestSummary) return checkpoint ? [checkpointMessage(checkpoint)] : [];
  if (!checkpoint) return [latestSummary];
  const checkpointAt = Date.parse(checkpoint.updatedAt);
  const summaryAt = typeof latestSummary.timestamp === 'number' ? latestSummary.timestamp : Number.NaN;
  return Number.isFinite(checkpointAt) && Number.isFinite(summaryAt) && checkpointAt < summaryAt
    ? [latestSummary]
    : [checkpointMessage(checkpoint)];
};

const fits = (messages: readonly HandoffMessage[], budget: HandoffBudget, overhead: HandoffOverhead): boolean => {
  if (messages.length > budget.maxMessages) return false;
  const cost = packCost(messages, budget, overhead);
  return cost.tokens <= budget.maxTokens && cost.bytes <= budget.maxBytes;
};

export const selectHandoffMessages = (
  messages: readonly HandoffMessage[],
  checkpoint: OperationalCheckpoint | undefined,
  budget: HandoffBudget = DEFAULT_HANDOFF_BUDGET,
  overhead: HandoffOverhead = NO_OVERHEAD,
): HandoffResult => {
  assertBudget(budget, overhead);
  const retained = messages.filter(message => !isRegenerableRecall(message));
  const pre = packCost(retained, budget, overhead);
  const prefix = continuityPrefix(retained, checkpoint);
  const turns = groupTurns(retained.filter(message => !isPiSummary(message)));
  const diagnostic = `Estimated tokens: system ${overhead.systemTokens} + tool-schema reserve ${budget.toolSchemaReserveTokens} + messages ${pre.messageTokens} = ${pre.tokens}. Bytes: system ${overhead.systemBytes} + messages ${pre.bytes - overhead.systemBytes} = ${pre.bytes}.`;
  const current = turns.at(-1);
  if (current && !turnIsComplete(current)) {
    return {
      ok: false, instruction: `Handoff refused: the current turn has an unmatched, duplicate, or orphaned tool call/result. ${diagnostic}`,
      preTokens: pre.tokens, preBytes: pre.bytes, systemTokens: overhead.systemTokens,
      toolSchemaReserveTokens: budget.toolSchemaReserveTokens,
    };
  }
  const minimum = current ? [...prefix, ...current.messages] : prefix;
  if (!fits(minimum, budget, overhead)) {
    return {
      ok: false,
      instruction: `${prefix.length
        ? 'Handoff refused: continuity checkpoint plus the current complete turn and provider overhead exceed the token/byte/message budget. Update a smaller checkpoint, increase the explicit budget, or start a new session.'
        : 'Handoff refused: no continuity checkpoint and the current turn plus provider overhead exceed the token/byte/message budget. Write a bounded /memory checkpoint before switching models.'} ${diagnostic}`,
      preTokens: pre.tokens, preBytes: pre.bytes, systemTokens: overhead.systemTokens,
      toolSchemaReserveTokens: budget.toolSchemaReserveTokens,
    };
  }
  const kept = { turns: current ? [current] : [] as Turn[] };
  const older = current ? turns.slice(0, -1) : turns;
  for (const turn of [...older].reverse()) {
    if (!turnIsComplete(turn)) continue;
    const candidate = [...prefix, ...[turn, ...kept.turns].flatMap(item => item.messages)];
    if (!fits(candidate, budget, overhead)) break;
    kept.turns = [turn, ...kept.turns];
  }
  const selected = [...prefix, ...kept.turns.flatMap(turn => turn.messages)];
  const post = packCost(selected, budget, overhead);
  const continuity = prefix[0]?.role === 'compactionSummary' || prefix[0]?.role === 'branchSummary'
    ? 'latest Pi summary' : prefix.length ? 'explicit checkpoint' : 'no checkpoint';
  return {
    ok: true, messages: selected, preTokens: pre.tokens, postTokens: post.tokens,
    preMessageTokens: pre.messageTokens, postMessageTokens: post.messageTokens,
    systemTokens: overhead.systemTokens, toolSchemaReserveTokens: budget.toolSchemaReserveTokens,
    preBytes: pre.bytes, postBytes: post.bytes, systemBytes: overhead.systemBytes,
    omittedTurns: Math.max(0, turns.length - kept.turns.length),
    reason: `Kept ${continuity} and ${kept.turns.length} complete turn(s); omitted ${Math.max(0, turns.length - kept.turns.length)} older turn(s). Tokens: system ${overhead.systemTokens} + tool-schema reserve ${budget.toolSchemaReserveTokens} + messages ${post.messageTokens} = ${post.tokens}. Bytes: system ${overhead.systemBytes} + messages ${post.bytes - overhead.systemBytes} = ${post.bytes}.`,
  };
};
