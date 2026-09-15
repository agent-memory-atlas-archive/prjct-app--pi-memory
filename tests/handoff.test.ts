import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { readCheckpoint, writeCheckpoint } from '../src/handoff/checkpoint.ts';
import { createHandoffController } from '../src/handoff/hooks.ts';
import { DEFAULT_HANDOFF_BUDGET, selectHandoffMessages } from '../src/handoff/select.ts';
import { groupTurns, type HandoffMessage } from '../src/handoff/turns.ts';
import { MemoryEngine } from '../src/engine.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const user = (text: string): HandoffMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string, ids: string[] = []): HandoffMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], toolCalls: ids.map(id => ({ id })),
});
const tool = (id: string, text: string): HandoffMessage => ({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }] });

test('grouping keeps tool calls with matching results', () => {
  const messages = [user('one'), assistant('call', ['t1']), tool('t1', 'ok'), user('two'), assistant('done')];
  const turns = groupTurns(messages);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]!.messages.map(message => message.role), ['user', 'assistant', 'toolResult']);
});

test('real Pi multi-call tool loops require a bijection and remain atomic out of order', () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const call: AssistantMessage = {
    role: 'assistant', content: [
      { type: 'toolCall', id: 'call_a', name: 'read', arguments: { path: 'README.md' } },
      { type: 'toolCall', id: 'call_b', name: 'read', arguments: { path: 'package.json' } },
    ],
    api: 'anthropic-messages', provider: 'anthropic', model: 'offline', usage, stopReason: 'toolUse', timestamp: 1,
  };
  const resultA: ToolResultMessage = {
    role: 'toolResult', toolCallId: 'call_a', toolName: 'read', content: [{ type: 'text', text: 'A' }], isError: false, timestamp: 3,
  };
  const resultB: ToolResultMessage = {
    role: 'toolResult', toolCallId: 'call_b', toolName: 'read', content: [{ type: 'text', text: 'B' }], isError: false, timestamp: 2,
  };
  assert.equal(selectHandoffMessages([user('inspect'), call, resultA], undefined).ok, false);
  assert.equal(selectHandoffMessages([user('inspect'), call, resultA, resultA, resultB], undefined).ok, false);
  const selected = selectHandoffMessages(
    [user('discard old'), assistant('old'), user('inspect'), call, resultB, resultA], undefined,
    { maxTokens: 8_000, maxBytes: 32_768, maxMessages: 4, toolSchemaReserveTokens: 0 },
  );
  assert.equal(selected.ok, true);
  if (selected.ok) assert.deepEqual(selected.messages, [user('inspect'), call, resultB, resultA]);
});

test('budget omits older complete turns and keeps the latest user turn', () => {
  const messages = [
    user('old requirement A'), assistant('old'),
    user('latest requirement B with evidence ev_1'), assistant('work', ['t2']), tool('t2', 'result'),
  ];
  const selected = selectHandoffMessages(messages, undefined, { maxTokens: 8_000, maxBytes: 32_768, maxMessages: 3, toolSchemaReserveTokens: 10 });
  assert.equal(selected.ok, true);
  if (selected.ok) {
    const texts = JSON.stringify(selected.messages);
    assert.match(texts, /latest requirement B/);
    assert.equal(texts.includes('old requirement A'), false);
    assert.match(texts, /t2/);
    assert.ok(selected.postTokens <= 80);
  }
});

test('latest Pi summary is the deterministic fallback unless an explicit checkpoint is newer', () => {
  const compaction: HandoffMessage = { role: 'compactionSummary', summary: 'Earlier verified decisions', timestamp: 100 };
  const branch: HandoffMessage = { role: 'branchSummary', summary: 'Returned branch result', timestamp: 200 };
  const messages = [compaction, user('old turn'), assistant('old answer'), branch, user('current turn'), assistant('current answer')];
  const budget = { maxTokens: 8_000, maxBytes: 32_768, maxMessages: 3, toolSchemaReserveTokens: 0 };
  const fallback = selectHandoffMessages(messages, undefined, budget);
  assert.equal(fallback.ok, true);
  if (fallback.ok) assert.deepEqual(fallback.messages, [branch, user('current turn'), assistant('current answer')]);
  const checkpoint = {
    projectId: 'p_test', sessionId: 's1', goal: 'New explicit goal', constraints: ['new constraint'], done: [],
    inProgress: [], blocked: [], decisions: [], evidenceRefs: ['ev_new'], nextSteps: [], updatedAt: new Date(300).toISOString(),
  } as const;
  const explicit = selectHandoffMessages(messages, checkpoint, budget);
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.match(JSON.stringify(explicit.messages), /New explicit goal/);
    assert.equal(explicit.messages.some(message => message.role === 'branchSummary'), false);
  }
  const newerSummary = selectHandoffMessages(messages, { ...checkpoint, updatedAt: new Date(150).toISOString() }, budget);
  assert.equal(newerSummary.ok, true);
  if (newerSummary.ok) assert.equal(newerSummary.messages[0]?.role, 'branchSummary');
});

test('unmatched tool pair is refused', () => {
  const selected = selectHandoffMessages([user('go'), assistant('call', ['missing'])], undefined);
  assert.equal(selected.ok, false);
});

test('no checkpoint and oversized current turn fails closed', () => {
  const huge = user('x'.repeat(20_000));
  const selected = selectHandoffMessages([huge], undefined, { maxTokens: 50, maxBytes: 100, maxMessages: 4, toolSchemaReserveTokens: 20 });
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.match(selected.instruction, /no (?:continuity )?checkpoint/i);
});

test('checkpoints are private project/session rows excluded from recall and semantic stats', async t => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-cp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // This assertion inspects indexed rows directly; compact checkpoint behavior
  // is covered through the public API in the compact runtime suite.
  const a = new MemoryEngine({ root: join(root, 'a'), scopeId: 'p_aaa', sessionId: 's1', provider: new TestEmbeddingProvider(), storage: 'indexed' });
  const b = new MemoryEngine({ root: join(root, 'b'), scopeId: 'p_bbb', sessionId: 's1', provider: new TestEmbeddingProvider(), storage: 'indexed' });
  t.after(async () => { await a.dispose(); await b.dispose(); });
  const before = a.projection.stats();
  const checkpoint = {
    projectId: 'p_aaa', sessionId: 'sess-a', goal: 'Ship isolation', constraints: ['no shared db'],
    done: [], inProgress: ['handoff'], blocked: [], decisions: ['sqlite'], evidenceRefs: ['ev_1'], nextSteps: ['review'],
    updatedAt: new Date().toISOString(),
  } as const;
  await writeCheckpoint(a, checkpoint);
  assert.deepEqual(readCheckpoint(a, 'sess-a'), checkpoint);
  const revised = { ...checkpoint, goal: 'Ship isolated handoff', updatedAt: new Date(Date.parse(checkpoint.updatedAt) + 1).toISOString() };
  await writeCheckpoint(a, revised);
  assert.deepEqual(readCheckpoint(a, 'sess-a'), revised);
  await assert.rejects(() => writeCheckpoint(a, checkpoint), /stale/);
  assert.deepEqual(readCheckpoint(a, 'sess-a'), revised);
  assert.equal(readCheckpoint(b, 'sess-a'), undefined);
  assert.throws(() => a.projection.operationalCheckpoint('p_bbb', 'sess-a'), /does not own/);
  assert.throws(() => a.projection.upsertOperationalCheckpoint('p_bbb', 'sess-x', '{}', Date.now()), /does not own/);
  const foreign = a.projection.db.prepare("SELECT COUNT(*) AS n FROM operational_checkpoints WHERE project_id='p_bbb'").get() as { n: number };
  assert.equal(foreign.n, 0);
  assert.equal(a.projection.documentByKey({ namespace: 'memory.checkpoint', externalId: 'session:sess-a' }), undefined);
  const after = a.projection.stats();
  assert.deepEqual({ documents: after.documents, chunks: after.chunks, vectors: after.vectors, facts: after.facts, events: after.events },
    { documents: before.documents, chunks: before.chunks, vectors: before.vectors, facts: before.facts, events: before.events });
  const recalled = await a.search({ queries: ['Ship isolation no shared db'], dense: false });
  assert.equal(recalled.items.length, 0);
  await assert.rejects(() => writeCheckpoint(a, { ...checkpoint, projectId: 'p_bbb' }), /projectId/);
  await assert.rejects(() => writeCheckpoint(a, { ...checkpoint, goal: 'x'.repeat(4_001) }), /4000 bytes/);
});

test('handler fault returns safe context and does not replay original', async () => {
  const controller = createHandoffController({
    engine: async () => { throw new Error('boom'); },
  });
  const original: HandoffMessage[] = [user('secret oversized original')];
  controller.activate('p_fault', '/fault/project', 's1', 'test fault');
  const notices: string[] = [];
  const aborted = { n: 0 };
  const result = await controller.safeContext(original, {
    cwd: '/fault/project',
    model: { provider: 'offline', id: 'b' },
    getSystemPrompt: () => 'short system prompt',
    abort: () => { aborted.n += 1; },
    ui: { notify: (message: string) => { notices.push(message); } },
    sessionManager: { getSessionId: () => 's1' },
  } as never);
  assert.equal(result.messages.length, 1);
  assert.equal(JSON.stringify(result.messages).includes('secret oversized original'), false);
  assert.equal(aborted.n, 1);
  assert.ok(notices.some(item => item.includes('fail-open') || item.includes('Handoff fault')));
});

test('model_select engine failure makes the next public context hook fail closed', async () => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = { on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); } };
  const controller = createHandoffController({ engine: async () => { throw new Error('owner unavailable'); } });
  const { installHandoffHooks } = await import('../src/handoff/hooks.ts');
  installHandoffHooks(pi as never, controller, async () => { throw new Error('owner unavailable'); });
  const aborted = { n: 0 };
  const ctx = {
    cwd: '/offline/project', model: { provider: 'offline', id: 'b' }, getSystemPrompt: () => 'short system prompt',
    abort: () => { aborted.n += 1; }, ui: { notify: () => undefined },
    sessionManager: { getSessionId: () => 's-failed' },
  };
  await handlers.get('model_select')!({
    model: { provider: 'offline', id: 'b' }, previousModel: { provider: 'offline', id: 'a' }, source: 'set',
  }, ctx);
  const result = await handlers.get('context')!({ messages: [user('private original')] }, ctx) as { messages: HandoffMessage[] };
  assert.equal(JSON.stringify(result.messages).includes('private original'), false);
  assert.match(JSON.stringify(result.messages), /failed safely/);
  assert.equal(aborted.n, 1);
});

test('context independently detects a missed model_select and arms bounded mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new MemoryEngine({ root, scopeId: 'p_observe', sessionId: 's-observe', provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const controller = createHandoffController({
    engine: async () => engine,
    budget: { maxTokens: 8_000, maxBytes: 2_000, maxMessages: 2, toolSchemaReserveTokens: 10 },
  });
  const ctx = {
    cwd: root, model: { provider: 'offline', id: 'a' }, getSystemPrompt: () => 'system', abort: () => undefined,
    ui: { notify: () => undefined }, sessionManager: { getSessionId: () => 's-observe' },
  };
  const history = [user('old history'), assistant('old answer'), user('current instruction')];
  assert.deepEqual((await controller.safeContext(history, ctx as never)).messages, history);
  ctx.model = { provider: 'offline', id: 'b' };
  const bounded = await controller.safeContext(history, ctx as never);
  assert.deepEqual(bounded.messages, [user('current instruction')]);
  assert.equal(controller.get(engine.scopeId, 's-observe')?.active, true);
});

test('measured system prompt plus tool reserve can consume the budget and refuses safely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-overhead-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new MemoryEngine({ root, scopeId: 'p_overhead', sessionId: 's-overhead', provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const controller = createHandoffController({
    engine: async () => engine,
    budget: { maxTokens: 30, maxBytes: 1_000, maxMessages: 2, toolSchemaReserveTokens: 20 },
  });
  controller.activate(engine.scopeId, root, 's-overhead', 'switched');
  const aborted = { n: 0 };
  const result = await controller.safeContext([user('latest')], {
    cwd: root, model: { provider: 'offline', id: 'b' }, getSystemPrompt: () => 'large system policy '.repeat(40),
    abort: () => { aborted.n += 1; }, ui: { notify: () => undefined },
    sessionManager: { getSessionId: () => 's-overhead' },
  } as never);
  assert.match(JSON.stringify(result.messages), /failed safely/);
  assert.equal(aborted.n, 1);
});

test('public context hook output is the bounded provider payload across A→B→A', async t => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-ab-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new MemoryEngine({ root, scopeId: 'p_handoff', sessionId: 's-ab', provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = { on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); } };
  const controller = createHandoffController({ engine: async () => engine, budget: { maxTokens: 8_000, maxBytes: 2_000, maxMessages: 4, toolSchemaReserveTokens: 20 } });
  const { installHandoffHooks } = await import('../src/handoff/hooks.ts');
  installHandoffHooks(pi as never, controller, async () => engine);
  const modelA = { provider: 'offline', id: 'a' };
  const modelB = { provider: 'offline', id: 'b' };
  const ctx = {
    cwd: root,
    model: modelB,
    getSystemPrompt: () => 'short system prompt',
    abort: () => undefined,
    ui: { notify: () => undefined },
    sessionManager: { getSessionId: () => 's-ab' },
  };
  await handlers.get('model_select')!({ model: modelB, previousModel: modelA, source: 'set' }, ctx);
  const history = [
    user('ancient dump '.repeat(40)), assistant('old'),
    user('keep this latest requirement'), assistant('call', ['t9']), tool('t9', 'ok'),
  ];
  const first = await handlers.get('context')!({ messages: history }, ctx) as { messages: HandoffMessage[] };
  ctx.model = modelA;
  await handlers.get('model_select')!({ model: modelA, previousModel: modelB, source: 'cycle' }, ctx);
  const second = await handlers.get('context')!({ messages: history }, ctx) as { messages: HandoffMessage[] };
  const outgoingProviderPayloads = [first.messages, second.messages];
  for (const payload of outgoingProviderPayloads) {
    const sent = JSON.stringify(payload);
    assert.match(sent, /keep this latest requirement/);
    assert.equal(sent.includes('ancient dump'), false);
  }
  assert.deepEqual(first.messages, second.messages);
  assert.equal(handlers.get('before_provider_request')!({ payload: { secret: 'do-not-log' } }, ctx), undefined);
});

test('A to B to A stays bounded across context calls', () => {
  const messages = [
    user('first'), assistant('a'),
    user('second'), assistant('b'),
    user('third latest'), assistant('c', ['z']), tool('z', 'ok'),
  ];
  const first = selectHandoffMessages(messages, undefined, { maxTokens: 120, maxBytes: 2_000, maxMessages: 8, toolSchemaReserveTokens: 10 });
  const again = selectHandoffMessages(messages, undefined, { maxTokens: 120, maxBytes: 2_000, maxMessages: 8, toolSchemaReserveTokens: 10 });
  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  if (first.ok && again.ok) {
    assert.match(JSON.stringify(first.messages), /third latest/);
    assert.deepEqual(first.messages, again.messages);
  }
});
