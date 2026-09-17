import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  keepBoundary, maskObservations, nextObservationFrontier, type ObservationPolicy,
} from '../src/handoff/observations.ts';
import { groupTurns, turnIsComplete, type HandoffMessage } from '../src/handoff/turns.ts';
import { createContextWindow } from '../src/handoff/window.ts';
import { budgetForModel } from '../src/handoff/select.ts';

const policy: ObservationPolicy = { enabled: true, keepRounds: 2, minTokens: 50, advanceTokens: 1_000 };
const user = (text: string): HandoffMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const call = (id: string, name: string, args: Record<string, unknown>): HandoffMessage => ({
  role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }],
});
const result = (id: string, text: string, toolName = 'read'): HandoffMessage => ({
  role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text }],
}) as HandoffMessage;
const big = (label: string) => Array.from({ length: 200 }, (_, index) => `${label} line ${index} lorem ipsum dolor sit amet`).join('\n');

const history = (): HandoffMessage[] => [
  user('investigate'),
  call('r1', 'read', { path: 'src/a.ts' }), result('r1', big('A')),
  call('b1', 'bash', { command: 'npm test' }), result('b1', `${big('LOG')}\nFAIL tests/x.test.ts expected 1 got 2`, 'bash'),
  call('g1', 'grep', { pattern: 'needle', path: 'src' }), result('g1', big('MATCH'), 'grep'),
  call('r2', 'read', { path: 'src/b.ts' }), result('r2', big('B')),
  call('r3', 'read', { path: 'src/c.ts' }), result('r3', big('C')),
];
const text = (message: HandoffMessage | undefined): string =>
  ((message?.content ?? []) as { text?: string }[]).map(block => block.text ?? '').join('\n');

test('stale outputs become stubs while the newest rounds, calls and pairs stay intact', () => {
  const messages = history();
  const frontier = nextObservationFrontier(messages, 0, policy);
  assert.equal(frontier, keepBoundary(messages, policy));
  const { messages: view, masked } = maskObservations(messages, frontier, policy);
  assert.equal(view.length, messages.length);
  assert.equal(masked, 3);
  for (const index of [0, 1, 3, 5, 7, 8, 9, 10]) assert.equal(view[index], messages[index]);
  assert.match(text(view[2]), /elided stale read output.*src\/a\.ts.*Read it again/s);
  assert.match(text(view[4]), /npm test/);
  assert.match(text(view[4]), /FAIL tests\/x\.test\.ts expected 1 got 2/, 'bash stubs keep the error tail');
  assert.match(text(view[6]), /needle/);
  assert.equal(view[2]!.toolCallId, 'r1');
  assert.ok(groupTurns(view).every(turnIsComplete));
});

test('the frontier waits for a full batch so the serialized prefix stays stable', () => {
  const messages = history();
  const lazy = { ...policy, advanceTokens: 1_000_000 };
  assert.equal(nextObservationFrontier(messages, 0, lazy), 0);
  const batch = { ...policy, advanceTokens: 2_500 };
  const first = nextObservationFrontier(messages, 0, batch);
  assert.ok(first > 0);
  const grown = [...messages, call('r4', 'read', { path: 'src/d.ts' }), result('r4', 'small')];
  // One more ~2k-token output falls behind the window: below the batch size, no advance.
  const second = nextObservationFrontier(grown, first, batch);
  assert.equal(second, first);
  assert.equal(JSON.stringify(maskObservations(grown, second, batch).messages.slice(0, messages.length)),
    JSON.stringify(maskObservations(messages, first, batch).messages));
});

test('small outputs and disabled policies are untouched', () => {
  const messages = history();
  assert.equal(maskObservations(messages, 9, { ...policy, enabled: false }).messages, messages);
  const small = [user('go'), call('s', 'read', { path: 'x' }), result('s', 'tiny'), call('t', 'read', { path: 'y' }), result('t', 'tiny'),
    call('u', 'read', { path: 'z' }), result('u', 'tiny')];
  assert.equal(maskObservations(small, keepBoundary(small, policy), policy).masked, 0);
});

test('the live window masks, keeps its frontier across calls, and resets on history replacement', () => {
  const window = createContextWindow(policy);
  const budget = budgetForModel({ contextWindow: 272_000, maxTokens: 128_000 });
  const overhead = { systemTokens: 0, systemBytes: 0, toolSchemaTokens: 0, toolSchemaBytes: 0 };
  const messages = history();
  const first = window(messages, undefined, budget, overhead);
  assert.equal(first.ok, true);
  assert.ok(first.observations && first.observations.masked === 3);
  const again = window([...messages, user('next')], undefined, budget, overhead);
  assert.equal(again.ok, true);
  assert.equal(again.observations, undefined, 'no second advance without a new batch');
  if (first.ok && again.ok) assert.deepEqual(again.messages.slice(0, first.messages.length), first.messages);
  const replaced = window([user('fresh after compaction'), ...messages.slice(1)], undefined, budget, overhead);
  assert.equal(replaced.ok, true);
  assert.ok(replaced.observations, 'replaced history recomputes the frontier from zero');
});

test('bash caps keep head, tail and a pointer; grep keeps first matches; read is never capped', async () => {
  const { capToolOutput } = await import('../src/handoff/caps.ts');
  const log = `START\n${'noise line\n'.repeat(5_000)}FAIL expected 1 got 2\n`;
  const bash = capToolOutput('bash', log, '/tmp/full.txt');
  assert.ok(bash && bash.length < 17_000);
  assert.match(bash!, /^START/);
  assert.match(bash!, /FAIL expected 1 got 2\n$/);
  assert.match(bash!, /saved to \/tmp\/full\.txt/);
  const grep = capToolOutput('grep', Array.from({ length: 2_000 }, (_, index) => `src/x.ts:${index}: match`).join('\n'), '/tmp/g.txt');
  assert.ok(grep && grep.length < 12_500);
  assert.match(grep!, /^src\/x\.ts:0: match/);
  assert.match(grep!, /more lines omitted; narrow the pattern/);
  assert.equal(capToolOutput('read', 'x'.repeat(200_000), '/tmp/r.txt'), undefined);
  assert.equal(capToolOutput('bash', 'short', '/tmp/s.txt'), undefined);
  assert.equal(capToolOutput('bash', log, '/tmp/full.txt', { enabled: false, bashChars: 1, bashHeadChars: 1, searchChars: 1 }), undefined);
});
