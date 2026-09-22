import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainHistory, turnKeyOf } from '../src/handoff/history.ts';
import { createTurnJudge } from '../src/handoff/turn-judge.ts';
import { groupTurns, type HandoffMessage } from '../src/handoff/turns.ts';

const user = (text: string): HandoffMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: text.length });
const assistant = (text: string): HandoffMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const conversation = (count: number, size = 2000): HandoffMessage[] => Array.from({ length: count }, (_, index) => [
  user(`Request ${index}: ${'x'.repeat(size)}`), assistant(`Answer ${index}: ${'y'.repeat(size)}`),
]).flat();
const policy = { enabled: true, targetTokens: 1_000_000, advanceTokens: 1_000_000, judgedAdvanceTokens: 1_500 };
const keys = (messages: readonly HandoffMessage[]) => groupTurns(messages).map(turnKeyOf);

test('turns Jev judged useless leave the context even under the size target; the latest four never do', () => {
  const messages = conversation(8);
  const ids = keys(messages);
  const verdicts = new Map(ids.map(id => [id, { reason: 'captured in memory' }]));
  const kept = retainHistory(messages, 0, policy, undefined, false, verdicts);
  assert.equal(kept.judged.turns, 4, 'eight turns: the current one and the three before it are protected');
  assert.match(JSON.stringify(kept.messages), /Retired turn .*Request 0: x.* · captured in memory/);
  assert.match(JSON.stringify(kept.messages), /Answer 7/);
  assert.match(JSON.stringify(kept.messages), /Answer 4/, 'protected turns are intact');
  assert.doesNotMatch(JSON.stringify(kept.messages), /Answer 3/);
  assert.ok(kept.messages.length < messages.length);
});

test('a turn without a verdict stays; too little to retire waits for a batch', () => {
  const messages = conversation(8);
  const ids = keys(messages);
  const two = retainHistory(messages, 0, policy, undefined, false, new Map([[ids[1]!, { reason: 'finished' }], [ids[2]!, { reason: 'finished' }]]));
  assert.equal(two.judged.turns, 2);
  assert.match(JSON.stringify(two.messages), /Answer 0/, 'no verdict, no retirement, even before the frontier');
  const one = retainHistory(messages, 0, policy, undefined, false, new Map([[ids[1]!, { reason: 'finished' }]]));
  assert.equal(one.judged.turns, 0, 'one small turn waits until a batch is worth the cache miss');
  const small = retainHistory(conversation(8, 50), 0, policy, undefined, false, new Map(keys(conversation(8, 50)).map(id => [id, { reason: 'finished' }])));
  assert.equal(small.frontier, 0, 'below the batch size the prefix is left alone, so the cache holds');
  assert.equal(retainHistory(messages, 0, policy).judged.turns, 0, 'no verdicts, only the structural policy');
});

test('Jev retires only what nothing needs and is captured or finished; unsure stays', async () => {
  const messages = conversation(9, 100);
  const answers: Record<string, number> = {
    t0_needed: 0.1, t0_captured: 0.9, t0_spent: 0,
    t1_needed: 0.1, t1_captured: 0.1, t1_spent: 0.8,
    t2_needed: 0.9, t2_captured: 0.9, t2_spent: 0.9,
    t3_needed: 0.3, t3_captured: 0.5, t3_spent: 0.5,
  };
  const calls: Record<string, unknown>[] = [];
  const judge = createTurnJudge({
    ask: async () => async (state: Record<string, unknown>, questions: Readonly<Record<string, string>>) => {
      calls.push(state);
      return new Map(Object.keys(questions).map(key => [key, answers[key] ?? 0]));
    },
    facts: async () => ['Tool schemas use typebox.'],
  });
  await judge.consider('s', messages);
  const ids = keys(messages);
  const verdicts = judge.verdicts('s');
  assert.equal(verdicts.get(ids[0]!)?.reason, 'captured in memory');
  assert.equal(verdicts.get(ids[1]!)?.reason, 'finished; nothing later depends on it');
  assert.equal(verdicts.has(ids[2]!), false, 'still needed');
  assert.equal(verdicts.has(ids[3]!), false, 'unsure stays');
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { memory_facts: string[] }).memory_facts, ['Tool schemas use typebox.']);
  await judge.consider('s', messages);
  assert.equal(calls.length, 1, 'a judged turn is never asked about again');
  const silent = createTurnJudge({ ask: async () => undefined, facts: async () => [] });
  await silent.consider('s', messages);
  assert.equal(silent.verdicts('s').size, 0, 'without Jev nothing is retired');
});
