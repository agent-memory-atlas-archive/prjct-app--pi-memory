import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { SourceRegistry, type SourceAdapter } from '../src/sources/registry.ts';
import { DEFAULT_SYNC_POLICY, dueAdapters, syncDecision } from '../src/sources/schedule.ts';
import { Projection } from '../src/storage/projection.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const openProjection = async (t: { after(fn: () => unknown): void }): Promise<Projection> => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-sched-'));
  const projection = new Projection(join(root, 'index.sqlite'));
  t.after(async () => { projection.close(); await rm(root, { recursive: true, force: true }); });
  return projection;
};

test('activity accumulates and survives reopening', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-act-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new Projection(join(root, 'index.sqlite'));
  assert.deepEqual({ ...first.activity(), updatedAt: 0 }, { turns: 0, tokens: 0, inserts: 0, updatedAt: 0 });
  first.recordActivity({ turns: 1, tokens: 900 });
  first.recordActivity({ turns: 1, tokens: 1_100, inserts: 2 });
  assert.deepEqual({ ...first.activity(), updatedAt: 0 }, { turns: 2, tokens: 2_000, inserts: 2, updatedAt: 0 });
  first.close();
  // The watermark is the point of the table: a new session continues counting.
  const second = new Projection(join(root, 'index.sqlite'));
  t.after(() => second.close());
  assert.equal(second.activity().turns, 2);
  // Negative or fractional deltas cannot walk the counters backwards.
  second.recordActivity({ turns: -5, tokens: 1.7 });
  assert.deepEqual({ ...second.activity(), updatedAt: 0 }, { turns: 2, tokens: 2_001, inserts: 2, updatedAt: 0 });
});

test('an adapter that has never run is due; one that just ran is not', async t => {
  const projection = await openProjection(t);
  const now = () => projection.activity();
  assert.equal(syncDecision('a', undefined, now(), DEFAULT_SYNC_POLICY).due, true);
  const run = projection.recordSync('a', { discovered: 5, indexed: 5, ok: true });
  assert.equal(syncDecision('a', run, now(), DEFAULT_SYNC_POLICY).due, false);
  assert.match(syncDecision('a', run, now(), DEFAULT_SYNC_POLICY).reason, /minimum is 300s/);
});

test('each threshold makes an adapter due on its own', async t => {
  const projection = await openProjection(t);
  const at = Date.now();
  const past = at - 10 * 60_000;
  const policy = { ...DEFAULT_SYNC_POLICY, everyTurns: 20, everyTokens: 40_000, everyInserts: 10 };
  const baseline = projection.recordSync('a', { at: past, discovered: 0, indexed: 0, ok: true });

  // Below every threshold: not due, and the reason says where it stands.
  projection.recordActivity({ turns: 19, tokens: 39_000, inserts: 9 });
  const held = syncDecision('a', baseline, projection.activity(), policy, at);
  assert.equal(held.due, false);
  assert.match(held.reason, /19 turns, 39000 tokens, 9 memories/);

  // One more turn crosses only the turn threshold, and that is enough.
  projection.recordActivity({ turns: 1 });
  const byTurns = syncDecision('a', baseline, projection.activity(), policy, at);
  assert.equal(byTurns.due, true);
  assert.match(byTurns.reason, /20 turns/);

  // Tokens alone, on a fresh watermark.
  const tokenMark = projection.recordSync('b', { at: past, discovered: 0, indexed: 0, ok: true });
  projection.recordActivity({ tokens: 40_000 });
  const byTokens = syncDecision('b', tokenMark, projection.activity(), policy, at);
  assert.equal(byTokens.due, true);
  assert.match(byTokens.reason, /tokens/);

  // Inserts alone.
  const insertMark = projection.recordSync('c', { at: past, discovered: 0, indexed: 0, ok: true });
  projection.recordActivity({ inserts: 10 });
  assert.equal(syncDecision('c', insertMark, projection.activity(), policy, at).due, true);
});

test('the minimum interval outranks a crossed threshold', async t => {
  const projection = await openProjection(t);
  const run = projection.recordSync('a', { discovered: 0, indexed: 0, ok: true });
  projection.recordActivity({ turns: 1_000, tokens: 10_000_000, inserts: 500 });
  assert.equal(syncDecision('a', run, projection.activity(), DEFAULT_SYNC_POLICY).due, false);
  // Once the interval has passed, the same counters make it due.
  assert.equal(syncDecision('a', run, projection.activity(), DEFAULT_SYNC_POLICY, Date.now() + 6 * 60_000).due, true);
});

test('disabling the policy stops everything from being due', async t => {
  const projection = await openProjection(t);
  const decisions = dueAdapters(projection, ['a', 'b'], { enabled: false });
  assert.deepEqual(decisions.map(d => d.due), [false, false]);
  assert.match(decisions[0]!.reason, /disabled/);
});

test('syncDue runs only what is due, records both outcomes, and one failure does not stop the rest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-due-'));
  const engine = await MemoryEngine.forScope('project', 'p_test', 's1', { home: root, provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });

  const document = (id: string) => ({ namespace: 'test', externalId: id, scopeId: 'p_test', scopeKind: 'project' as const,
    source: 'fixture', kind: 'note', text: `content ${id}`, version: id, contentHash: id.padEnd(64, '0').replace(/[^0-9a-f]/g, '0'),
    observedAt: '2026-01-01T00:00:00.000Z', trust: 'host' as const, metadata: {} });
  const good: SourceAdapter = { id: 'good', scope: { kind: 'project', id: 'p_test' }, scan: async () => [document('aa')] };
  const bad: SourceAdapter = { id: 'bad', scope: { kind: 'project', id: 'p_test' }, scan: async () => { throw new Error('source is unreachable'); } };
  const registry = new SourceRegistry();
  registry.register(good);
  registry.register(bad);

  // Neither has ever run, so both are due; the failure is recorded, not thrown.
  const first = await registry.syncDue(async () => engine, engine.projection);
  assert.deepEqual(first.ran.map(r => r.adapter), ['good']);
  assert.deepEqual(first.failed.map(f => f.adapter), ['bad']);
  assert.deepEqual(first.skipped, []);
  assert.equal(engine.projection.syncState('good')?.ok, true);
  assert.equal(engine.projection.syncState('bad')?.ok, false);
  assert.match(engine.projection.syncState('bad')!.detail!, /Source sync failed/);

  // Immediately after, nothing is due: the watermark is doing its job.
  const second = await registry.syncDue(async () => engine, engine.projection);
  assert.deepEqual(second.ran, []);
  assert.deepEqual(second.skipped.map(s => s.adapter), ['bad', 'good']);
});

test('an explicit sync records its run even when nothing was due', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-explicit-'));
  const engine = await MemoryEngine.forScope('project', 'p_test', 's1', { home: root, provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const adapter: SourceAdapter = { id: 'only', scope: { kind: 'project', id: 'p_test' }, scan: async () => [] };
  const registry = new SourceRegistry();
  registry.register(adapter);
  await registry.sync(async () => engine, 'only', undefined, engine.projection);
  const before = engine.projection.syncState('only')!;
  assert.equal(before.ok, true);
  assert.equal(dueAdapters(engine.projection, ['only']).every(d => !d.due), true);
  // Forced again: the watermark moves even though the policy would have skipped.
  engine.projection.recordActivity({ turns: 3 });
  await registry.sync(async () => engine, 'only', undefined, engine.projection);
  assert.equal(engine.projection.syncState('only')!.at.turns, 3);
});
