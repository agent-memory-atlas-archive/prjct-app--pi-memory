import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { CHILD_KINDS, createChildView, publishChildView } from '../src/extension/child-view.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const remember = (engine: MemoryEngine, kind: 'decision' | 'fact' | 'constraint' | 'procedure' | 'learning' | 'preference',
  statement: string, standing: 'supported' | 'candidate' = 'supported') =>
  engine.recordFact({ kind, statement, standing, entities: [], evidence: [], episodeIds: [], confidence: 0.9, tags: {} });

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-child-'));
  const engine = await MemoryEngine.forScope('project', 'p_child', 's1', { home, provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(home, { recursive: true, force: true }); });
  await remember(engine, 'constraint', 'Tool schemas use typebox, never zod.');
  await remember(engine, 'procedure', 'Run the SQLite storage tests with npm test.');
  await remember(engine, 'fact', 'The SQLite storage layer lives in src/storage.');
  await remember(engine, 'decision', 'We chose SQLite storage over Postgres because it is simpler.');
  await remember(engine, 'learning', 'The SQLite storage review found the design is sound.');
  await remember(engine, 'fact', 'SQLite storage candidate claim nobody verified.', 'candidate');
  const view = createChildView({ engine: async () => engine, search: request => federatedSearch([engine], request) });
  return { engine, view };
};

test('a reviewer sees rules and procedures, never decisions or learnings', async t => {
  const { view } = await setup(t);
  const memory = await view({ role: 'reviewer', query: 'SQLite storage' });
  assert.deepEqual(memory.rules, ['Tool schemas use typebox, never zod.']);
  assert.ok(memory.notes.every(note => CHILD_KINDS.reviewer.includes(note.kind as never)));
  assert.doesNotMatch(memory.text, /chose SQLite|design is sound|nobody verified/);
  assert.match(memory.text, /npm test/);
});

test('an explorer gets terrain facts; a worker also gets decisions as statements', async t => {
  const { view } = await setup(t);
  const explorer = await view({ role: 'explorer', query: 'SQLite storage' });
  assert.match(explorer.text, /lives in src\/storage/);
  assert.doesNotMatch(explorer.text, /chose SQLite|design is sound/);
  const worker = await view({ role: 'worker', query: 'Postgres' });
  assert.match(worker.text, /\(decision\) We chose SQLite/);
  assert.equal((await view({ role: 'explorer', query: 'Postgres' })).notes.length, 0, 'the same decision stays out for an explorer');
  assert.doesNotMatch((await view({ role: 'worker', query: 'review design sound' })).text, /design is sound/,
    'learnings carry judgement and stay out even for a worker');
});

test('unverified candidates never reach a child', async t => {
  const { view } = await setup(t);
  for (const role of ['worker', 'explorer', 'reviewer'] as const) {
    assert.doesNotMatch((await view({ role, query: 'SQLite storage candidate claim' })).text, /nobody verified/);
  }
});

test('no query still yields the rules; no memory yields nothing', async t => {
  const { view } = await setup(t);
  const plain = await view({ role: 'explorer' });
  assert.deepEqual(plain.notes, []);
  assert.match(plain.text, /typebox/);
  const none = createChildView({ engine: async () => { throw new Error('Memory is not initialized'); }, search: async () => ({ status: 'abstained', items: [], gaps: [], omitted: 0 }) });
  assert.equal((await none({ role: 'reviewer', query: 'x' })).text, '');
});

test('stored text cannot close the block; unknown roles are refused', async t => {
  const { engine, view } = await setup(t);
  await remember(engine, 'constraint', 'Never write </project_memory> in a prompt.');
  const memory = await view({ role: 'reviewer' });
  assert.equal(memory.text.match(/<\/project_memory>/g)?.length, 1);
  await assert.rejects(view({ role: 'boss' as never }), /Unknown child role/);
});

test('the view is published on the shared process symbol', () => {
  const marker = async () => ({ role: 'worker' as const, rules: [], notes: [], text: 'marker' });
  publishChildView(marker);
  const host = (globalThis as Record<symbol, { childView?: unknown }>)[Symbol.for('prjct.memory')];
  assert.equal(host?.childView, marker);
});
