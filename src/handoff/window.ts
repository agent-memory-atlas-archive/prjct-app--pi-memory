import { createHash } from 'node:crypto';
import type { OperationalCheckpoint } from './checkpoint.ts';
import { selectHandoffMessages, type HandoffBudget, type HandoffOverhead, type HandoffResult } from './select.ts';
import type { HandoffMessage } from './turns.ts';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isSummary = (message: HandoffMessage): boolean =>
  message.role === 'compactionSummary' || message.role === 'branchSummary';

/** Keep the first retained copy: deleting it would invalidate the cached prefix. */
const uniqueRecall = (messages: readonly HandoffMessage[]): readonly HandoffMessage[] => {
  const seen = new Set<string>();
  return messages.filter(message => {
    if ((message as HandoffMessage & { customType?: string }).customType !== 'pi-memory-recall') return true;
    const key = digest(message.content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Session-local watermark, not a provider cache. No transcript or state is written to disk. */
export const createContextWindow = () => {
  const state = { floor: 0, prefix: '' };
  return (messages: readonly HandoffMessage[], checkpoint: OperationalCheckpoint | undefined,
    budget: HandoffBudget, overhead: HandoffOverhead): HandoffResult => {
    // Compaction/tree edits replace the source history; only append-only histories
    // may reuse the watermark. Hashes work with Pi's deep-copied context events.
    const floor = state.floor < messages.length
      && state.prefix === digest(messages.slice(0, state.floor + 1)) ? state.floor : 0;
    const summary = messages.filter(isSummary).at(-1);
    const candidates = uniqueRecall([
      ...(summary ? [summary] : []), ...messages.slice(floor).filter(message => !isSummary(message)),
    ]);
    const selected = selectHandoffMessages(candidates, checkpoint, budget, overhead);
    if (!selected.ok) return selected;
    // Prune in batches, leaving growth room instead of shifting the cache prefix
    // on every next turn. The mandatory current turn always uses the hard limits.
    // A truncated pack is already at the hard limit; shrinking toward 75% would only cut more evidence.
    const compact = selected.omittedTurns > 0 && selected.truncatedFields === 0 ? selectHandoffMessages(candidates, checkpoint, {
      ...budget,
      maxTokens: Math.max(1, Math.floor(budget.maxTokens * 0.75)),
      maxBytes: Math.max(1, Math.floor(budget.maxBytes * 0.75)),
      maxMessages: Math.max(1, Math.floor(budget.maxMessages * 0.75)),
    }, overhead) : selected;
    const result = compact.ok ? compact : selected;
    const first = result.messages.find(message => !isSummary(message) && messages.includes(message));
    const nextFloor = first ? messages.indexOf(first) : floor;
    state.floor = Math.max(floor, nextFloor);
    state.prefix = digest(messages.slice(0, state.floor + 1));
    return result;
  };
};
