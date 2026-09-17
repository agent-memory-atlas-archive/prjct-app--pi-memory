import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextWindow } from '../src/handoff/window.ts';
import { createHandoffController, installHandoffHooks } from '../src/handoff/hooks.ts';
import type { HandoffMessage } from '../src/handoff/turns.ts';

const user = (content: string): HandoffMessage => ({ role: 'user', content });
const answer = (content: string): HandoffMessage => ({ role: 'assistant', content: [{ type: 'text', text: content }] });
const budget = { maxTokens: 8_000, maxBytes: 32_768, maxMessages: 8, toolSchemaReserveTokens: 0 };
const overhead = { systemTokens: 0, systemBytes: 0 };
const context = () => ({
  cwd: '/transient', model: { provider: 'offline', id: 'a' }, getSystemPrompt: () => 'stable policy',
  abort: () => undefined, ui: { notify: () => undefined }, sessionManager: { getSessionId: () => 's' },
});

test('batch pruning leaves an append-only prefix and never resurrects discarded turns', () => {
  const select = createContextWindow();
  const original = Array.from({ length: 8 }, (_, n) => [user(`user ${n}`), answer(`answer ${n}`)]).flat();
  const first = select(original, undefined, budget, overhead);
  assert.ok(first.ok);
  assert.equal(first.messages.length, 6); // 75% watermark, not full to the limit
  const same = select(structuredClone(original), undefined, budget, overhead);
  assert.ok(same.ok);
  assert.deepEqual(same.messages, first.messages);
  const grown = [...original, user('next requirement')];
  const next = select(grown, undefined, budget, overhead);
  assert.ok(next.ok);
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.equal(next.messages.at(-1)?.content, 'next requirement');
  // A larger budget / cheaper overhead must not re-introduce the evicted prefix.
  const larger = select(grown, undefined, { ...budget, maxMessages: 100 }, overhead);
  assert.ok(larger.ok);
  assert.deepEqual(larger.messages, next.messages);
});

test('history replacement resets the watermark and retains the new summary', () => {
  const select = createContextWindow();
  select(Array.from({ length: 10 }, (_, n) => user(`old ${n}`)), undefined, budget, overhead);
  const summary: HandoffMessage = { role: 'compactionSummary', summary: 'MANUAL_COMPACTION', timestamp: 5 };
  const replacement = [summary, user('new branch requirement')];
  const next = select(replacement, undefined, budget, overhead);
  assert.ok(next.ok);
  assert.deepEqual(next.messages, replacement);
});

test('exact recall dedup preserves the first cached copy and re-emits after eviction', () => {
  const select = createContextWindow();
  const recall = { role: 'custom', customType: 'pi-memory-recall', content: 'same retained fact', timestamp: 1 };
  const initial = [user('first'), recall, answer('done')];
  const first = select(initial, undefined, budget, overhead);
  assert.ok(first.ok);
  const again = [...initial, user('second'), { ...recall, timestamp: 2 }];
  const second = select(again, undefined, budget, overhead);
  assert.ok(second.ok);
  assert.deepEqual(second.messages, [...first.messages, user('second')]);
  const evicted = select([user('fresh after compact'), { ...recall, timestamp: 3 }], undefined, budget, overhead);
  assert.ok(evicted.ok);
  assert.equal(evicted.messages.length, 2);
});

test('distinct recall is retained without modifying previously cached messages', () => {
  const select = createContextWindow();
  const history = [user('one'), { role: 'custom', customType: 'pi-memory-recall', content: 'fact A' }, answer('done')];
  const first = select(history, undefined, budget, overhead);
  assert.ok(first.ok);
  const next = select([...history, user('two'), { role: 'custom', customType: 'pi-memory-recall', content: 'fact B' }], undefined, budget, overhead);
  assert.ok(next.ok);
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.match(JSON.stringify(next.messages), /fact B/);
});

test('a mandatory oversized current turn is refused, not silently clipped or sent in full', async () => {
  const controller = createHandoffController({ engine: async () => undefined, budget });
  const result = await controller.safeContext([user('PRIVATE_OVERSIZED ' + 'x'.repeat(100_000))], context() as never);
  assert.match(JSON.stringify(result.messages), /failed safely/);
  assert.doesNotMatch(JSON.stringify(result.messages), /PRIVATE_OVERSIZED/);
});

test('concurrent context waits for pending ownership and cannot replay original history', async () => {
  const deferred: { reject?: (error: Error) => void } = {};
  const controller = createHandoffController({ engine: () => new Promise((_resolve, reject) => { deferred.reject = reject; }), budget });
  const ctx = context();
  const activation = controller.prepare(ctx as never, 'switch');
  const bounded = controller.safeContext([user('PRIVATE_HISTORY')], ctx as never);
  await Promise.resolve();
  assert.ok(deferred.reject);
  deferred.reject(new Error('invalid owner'));
  await activation;
  const result = await bounded;
  assert.doesNotMatch(JSON.stringify(result.messages), /PRIVATE_HISTORY/);
  assert.match(JSON.stringify(result.messages), /failed safely/);
});

test('automatic threshold and overflow compaction are canceled without inference; manual is explicit', async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const engine = async () => undefined;
  const controller = createHandoffController({ engine, budget });
  installHandoffHooks({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, controller, engine);
  const ctx = context();
  const compact = handlers.get('session_before_compact')!;
  assert.deepEqual(await compact({ reason: 'threshold' }, ctx), { cancel: true });
  assert.deepEqual(await compact({ reason: 'overflow' }, ctx), { cancel: true });
  assert.equal(await compact({ reason: 'manual' }, ctx), undefined);
  ctx.ui.notify = () => { throw new Error('UI unavailable'); };
  controller.clear();
  assert.deepEqual(await compact({ reason: 'threshold' }, ctx), { cancel: true });
});

test('a session clear after activation settles cannot transport an older context into the same session key', async () => {
  const deferred: { resolve?: (value: undefined) => void } = {};
  const engine = { current: undefined as any };
  const controller = createHandoffController({
    engine: () => engine.current ? Promise.resolve(engine.current) : new Promise(resolve => { deferred.resolve = resolve; }), budget,
  });
  const ctx = context();
  const activating = controller.prepare(ctx as never, 'old switch');
  const clearing = activating.then(() => {
    controller.clear();
    engine.current = { scopeId: 'p_new', projection: { operationalCheckpoint: () => undefined } };
    controller.activate('p_new', ctx.cwd, 's', 'new session with same key');
  });
  const oldContext = controller.safeContext([user('OLD_PRIVATE_CONTEXT')], ctx as never);
  await Promise.resolve();
  deferred.resolve!(undefined);
  await clearing;
  const oldResult = await oldContext;
  assert.match(JSON.stringify(oldResult.messages), /failed safely/);
  assert.doesNotMatch(JSON.stringify(oldResult.messages), /OLD_PRIVATE_CONTEXT/);
  const current = await controller.safeContext([user('NEW_CONTEXT')], ctx as never);
  assert.deepEqual(current.messages, [user('NEW_CONTEXT')]);
});

test('refusal itself respects tiny message budgets and does not add an oversized SAFE message', async () => {
  const controller = createHandoffController({ engine: async () => undefined,
    budget: { maxTokens: 10, maxBytes: 30, maxMessages: 1, toolSchemaReserveTokens: 0 } });
  const result = await controller.safeContext([user('PRIVATE_LARGE ' + 'x'.repeat(1000))], context() as never);
  assert.deepEqual(result.messages, []);
});
