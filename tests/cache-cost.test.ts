import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextWindow } from '../src/handoff/window.ts';
import { budgetForModel, estimateHandoffTokens } from '../src/handoff/select.ts';
import { DEFAULT_OBSERVATION_POLICY, type ObservationPolicy } from '../src/handoff/observations.ts';
import type { HandoffMessage } from '../src/handoff/turns.ts';

// Message-boundary serialized-prefix proxy, not provider billing. System/tools
// are fixed in this fixture; cache read discount and expiry are explicit inputs.
const replay = (policy: ObservationPolicy, retentionMs: number) => {
  const window = createContextWindow(policy);
  const budget = budgetForModel({ contextWindow: 272_000, maxTokens: 128_000 });
  const overhead = { systemTokens: 0, systemBytes: 0, toolSchemaTokens: 0 };
  const state = { previous: [] as string[], at: -Infinity, now: 0, warm: 0, cold: 0, tokens: 0, advances: 0 };
  const history: HandoffMessage[] = [{ role: 'user', content: 'Inspect the repository without modifying it.' }];
  const send = (cold: boolean) => {
    const selected = window(structuredClone(history), undefined, budget, overhead);
    assert.ok(selected.ok);
    const serialized = selected.messages.map(message => JSON.stringify(message));
    const shared = serialized.findIndex((message, index) => message !== state.previous[index]);
    const prefix = state.now - state.at >= retentionMs ? 0 : shared < 0 ? serialized.length : shared;
    const sizes = selected.messages.map(estimateHandoffTokens);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const uncached = sizes.slice(prefix).reduce((sum, size) => sum + size, 0);
    const cost = uncached + 0.1 * (total - uncached);
    if (cold) state.cold += cost; else state.warm += cost;
    state.tokens += total;
    if (selected.observations) state.advances += 1;
    state.previous = serialized;
    state.at = state.now;
    return serialized;
  };
  for (const n of Array.from({ length: 60 }, (_, index) => index)) {
    const result: HandoffMessage & { toolName: string } = {
      role: 'toolResult', toolCallId: `read-${n}`, toolName: 'read',
      content: [{ type: 'text', text: 'source line\n'.repeat(700) }],
    };
    history.push({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'Inspect next file.', thinkingSignature: `signed-${n}` },
      { type: 'toolCall', id: `read-${n}`, name: 'read', arguments: { path: `src/file-${n}.ts` } },
    ] }, result);
    state.now += 1_000;
    send(false);
  }
  const before = state.previous;
  const advances = state.advances;
  state.now += 6 * 60 * 1_000;
  assert.deepEqual(send(true), before, 'idle alone must not rewrite any serialized messages');
  assert.equal(state.advances, advances, 'no frontier movement without material growth');
  return { warm: Math.round(state.warm), cold: Math.round(state.cold), total: Math.round(state.warm + state.cold), tokens: state.tokens, advances: state.advances };
};

const stable: ObservationPolicy = { enabled: true, keepRounds: 8, minTokens: 300, advanceTokens: 24_000 };
const aggressive: ObservationPolicy = { enabled: true, keepRounds: 4, minTokens: 300, advanceTokens: 300 };

test('batched default reduces warm plus simulated cold cost, not merely raw tokens', t => {
  const batched = replay(stable, 5 * 60 * 1_000);
  const eager = replay(aggressive, 5 * 60 * 1_000);
  t.diagnostic(JSON.stringify({ simulatedExpiryMs: 300_000, batched, eager }));
  assert.ok(batched.warm < eager.warm);
  assert.ok(batched.total < eager.total);
  assert.ok(batched.advances < eager.advances);
  assert.ok(batched.tokens > eager.tokens, 'fewer raw tokens alone is not proof of lower cost');
  assert.deepEqual(DEFAULT_OBSERVATION_POLICY, stable, 'default must retain measured stable-prefix batching');
});

test('six-minute idle is cold only when the simulated provider retention expires', t => {
  const expired = replay(stable, 5 * 60 * 1_000);
  const retained = replay(stable, 60 * 60 * 1_000);
  assert.equal(expired.warm, retained.warm);
  assert.ok(expired.cold > retained.cold * 9.9);
  assert.equal(expired.tokens, retained.tokens);
  t.diagnostic(JSON.stringify({ expired, retained }));
});
