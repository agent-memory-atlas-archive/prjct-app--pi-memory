/**
 * Replays the LLM calls of real Pi sessions and measures what each context
 * policy would have sent. Read-only: session files are never modified.
 *
 *   node --import tsx scripts/replay-context.ts <session.jsonl>... [--keep 8,12] [--min 300] [--advance 24000]
 *
 * For every assistant message on the active branch, the context Pi sent is
 * rebuilt from the entries before it. "Uncached" approximates what a provider
 * prompt cache cannot reuse: tokens after the longest message prefix shared with
 * the previous call. "Effective" weights cached tokens at 10% of uncached, the
 * usual provider discount for cache reads.
 */
import { buildSessionContext, SessionManager } from '@earendil-works/pi-coding-agent';
import { budgetForModel, estimateHandoffTokens } from '../src/handoff/select.ts';
import { createContextWindow } from '../src/handoff/window.ts';
import { capToolOutput } from '../src/handoff/caps.ts';
import {
  DEFAULT_OBSERVATION_POLICY, maskObservations, nextObservationFrontier, type ObservationPolicy,
} from '../src/handoff/observations.ts';
import type { HandoffMessage } from '../src/handoff/turns.ts';

type Policy = Readonly<{ label: string; observations?: ObservationPolicy; live?: boolean; caps?: boolean }>;
type Totals = { calls: number; tokens: number; uncached: number; advances: number; masked: number };

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const numbers = (value: string | undefined, fallback: number): number[] =>
  value ? value.split(',').map(Number).filter(Number.isFinite) : [fallback];
const files = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
if (!files.length) {
  console.error('Usage: replay-context.ts <session.jsonl>... [--keep 8,12] [--min 300] [--advance 24000]');
  process.exit(2);
}

const policies: Policy[] = [{ label: 'baseline' }, ...numbers(flag('keep'), DEFAULT_OBSERVATION_POLICY.keepRounds)
  .flatMap(keepRounds => numbers(flag('min'), DEFAULT_OBSERVATION_POLICY.minTokens)
    .flatMap(minTokens => numbers(flag('advance'), DEFAULT_OBSERVATION_POLICY.advanceTokens)
      .map(advanceTokens => ({
        label: `mask keep=${keepRounds} min=${minTokens} advance=${advanceTokens}`,
        observations: { enabled: true, keepRounds, minTokens, advanceTokens },
      }))))];
// The shipped pipeline end to end: default masking plus model-window selection (272k model).
policies.push({ label: 'live window (defaults, 272k model)', live: true });
policies.push({ label: 'live window + output caps', live: true, caps: true });

// Source caps are applied once when a result arrives; memoize so replays stay byte-stable.
const capped = new WeakMap<object, HandoffMessage>();
const withCaps = (messages: readonly HandoffMessage[]): HandoffMessage[] => messages.map(message => {
  const toolName = (message as { toolName?: unknown }).toolName;
  if (message.role !== 'toolResult' || typeof toolName !== 'string' || !Array.isArray(message.content)) return message;
  const known = capped.get(message);
  if (known) return known;
  const blocks = message.content as { type?: string; text?: string }[];
  const text = blocks.every(block => block.type === 'text') ? capToolOutput(toolName, blocks.map(block => block.text ?? '').join('\n'), '/tmp/pi-memory-tool-output/replay.txt') : undefined;
  const next = text === undefined ? message : { ...message, content: [{ type: 'text', text }] } as HandoffMessage;
  capped.set(message, next);
  return next;
});
const liveBudget = budgetForModel({ contextWindow: 272_000, maxTokens: 128_000 });

const tokensOf = (messages: readonly HandoffMessage[]): number[] => messages.map(estimateHandoffTokens);
const serialize = (messages: readonly HandoffMessage[]): string[] => messages.map(message => JSON.stringify(message));

for (const file of files) {
  const manager = SessionManager.open(file);
  const branch = manager.getBranch();
  const byId = new Map(manager.getEntries().map(entry => [entry.id, entry]));
  const totals = new Map(policies.map(policy => [policy.label, { calls: 0, tokens: 0, uncached: 0, advances: 0, masked: 0 } as Totals]));
  const state = new Map(policies.map(policy => [policy.label, { frontier: 0, previous: [] as string[], history: '' }]));
  const lives = new Map(policies.filter(policy => policy.live).map(policy => [policy.label, createContextWindow()]));
  const started = Date.now();
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant' || index === 0) continue;
    const context = buildSessionContext(branch.slice(0, index), branch[index - 1]!.id, byId).messages as HandoffMessage[];
    for (const policy of policies) {
      const total = totals.get(policy.label)!;
      const slot = state.get(policy.label)!;
      // Compaction replaces history: reset the frontier like the live window does.
      const head = context[0] ? JSON.stringify(context[0]) : '';
      if (head !== slot.history) slot.frontier = 0;
      slot.history = head;
      const view = policy.live
        ? (() => {
          const selected = lives.get(policy.label)!(policy.caps ? withCaps(context) : context, undefined, liveBudget, { systemTokens: 0, systemBytes: 0, toolSchemaTokens: 0, toolSchemaBytes: 0 });
          if (!selected.ok) throw new Error(selected.instruction);
          if (selected.observations) total.advances += 1;
          return selected.messages;
        })()
        : policy.observations
        ? (() => {
          const next = nextObservationFrontier(context, slot.frontier, policy.observations!);
          if (next > slot.frontier) total.advances += 1;
          slot.frontier = next;
          const masked = maskObservations(context, next, policy.observations!);
          return masked.messages;
        })()
        : context;
      const serialized = serialize(view);
      const tokens = tokensOf(view);
      const shared = serialized.findIndex((item, at) => item !== slot.previous[at]);
      const prefix = shared < 0 ? serialized.length : shared;
      total.calls += 1;
      total.tokens += tokens.reduce((sum, value) => sum + value, 0);
      total.uncached += tokens.slice(prefix).reduce((sum, value) => sum + value, 0);
      total.masked += view.filter((message, at) => message !== context[at]).length;
      slot.previous = serialized;
    }
  }
  const base = totals.get('baseline')!;
  console.log(`\n== ${file.split('/').slice(-2).join('/')} (${base.calls} calls, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log('policy'.padEnd(44), 'msg tokens'.padStart(12), 'vs base'.padStart(8), 'uncached'.padStart(11), 'vs base'.padStart(8), 'mean/call'.padStart(10), 'advances'.padStart(9), 'effective'.padStart(11), 'vs base'.padStart(8));
  const effective = (total: Totals): number => Math.round(total.uncached + 0.1 * (total.tokens - total.uncached));
  for (const [label, total] of totals) {
    const pct = (value: number, of: number) => `${of ? ((100 * value) / of - 100).toFixed(1) : '0'}%`;
    console.log(label.padEnd(44), String(total.tokens).padStart(12), pct(total.tokens, base.tokens).padStart(8),
      String(total.uncached).padStart(11), pct(total.uncached, base.uncached).padStart(8),
      String(Math.round(total.tokens / Math.max(total.calls, 1))).padStart(10), String(total.advances).padStart(9),
      String(effective(total)).padStart(11), pct(effective(total), effective(base)).padStart(8));
  }
}
