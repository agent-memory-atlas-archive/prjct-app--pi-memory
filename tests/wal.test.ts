import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryEngine } from '../src/engine.ts';
import { TestEmbeddingProvider } from './helpers.ts';

// These tests exercise the indexed WAL policy specifically. Compact WAL
// pressure has its own pinned-reader and byte-envelope suite.
const open = (root: string) => new MemoryEngine({ root, scopeId: 'p_wal', sessionId: 'test', provider: new TestEmbeddingProvider(), storage: 'indexed' });
const child = async (root: string, mode: string) => {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', new URL('./wal-child.mts', import.meta.url).pathname, root, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('child timed out')); }, 10000);
    process.once('error', error => { clearTimeout(timeout); reject(error); });
    process.stdout.on('data', data => { if (String(data).includes('READY')) { clearTimeout(timeout); resolve(); } });
    process.once('exit', code => { clearTimeout(timeout); reject(new Error(`child exited early ${code}`)); });
  });
  return process;
};
const kill = async (process: Awaited<ReturnType<typeof child>>) => { const exit = once(process, 'exit'); process.kill('SIGKILL'); await exit; };

test('WAL maintenance yields to pinned reader and competing writer, restores timeout and drains after release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wal-concurrency-'));
  const engine = open(root);
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  engine.projection.checkpointWal();
  const reader = await child(root, 'reader');
  try {
    await engine.recordFact({ kind: 'fact', statement: 'SQLite checkpoint concurrency', entities: [], evidence: [], episodeIds: [], confidence: 1, tags: {} });
    const start = performance.now();
    assert.equal(engine.projection.checkpointWal().status, 'busy');
    assert.ok(performance.now() - start < 2000);
  } finally { await kill(reader); }
  const writer = await child(root, 'writer');
  try { assert.equal(engine.projection.checkpointWal().status, 'busy'); } finally { await kill(writer); }
  assert.equal(engine.projection.checkpointWal().status, 'checkpointed');
  assert.equal((await stat(join(root, 'memory.sqlite-wal'))).size, 0);
  assert.equal(Number(Object.values(engine.projection.db.prepare('PRAGMA busy_timeout').get()!)[0]), 5000);
  assert.equal(Number(Object.values(engine.projection.db.prepare('PRAGMA synchronous').get()!)[0]), 2);
  assert.throws(() => engine.authorityTransaction(() => engine.projection.checkpointWal()), /authority transaction/);
});

for (const mode of ['pre-commit', 'post-commit', 'post-checkpoint']) {
  test(`SIGKILL ${mode}: checkpoint policy preserves all-or-nothing authority, restart and rebuild`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'wal-crash-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const initial = open(root); await initial.dispose();
    const writer = await child(root, mode); await kill(writer);
    const engine = open(root);
    try {
      const expected = mode === 'pre-commit' ? 0 : 2;
      assert.equal(engine.projection.stats().facts, expected);
      await engine.rebuild();
      assert.equal(engine.projection.stats().facts, expected);
      assert.equal((await engine.search({ queries: ['authority'], dense: false })).items.length, expected);
      assert.equal(engine.projection.checkpointWal().status, 'checkpointed');
    } finally { await engine.dispose(); }
  });
}

test('repeated committed batches release WAL high-water allocation at every quiescent boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wal-batches-'));
  const engine = open(root);
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const round of Array.from({ length: 30 }, (_, n) => n)) {
    await engine.recordFact({ kind: 'fact', statement: `Batch ${round} SQLite durability ${'evidence '.repeat(80)}`,
      confidence: 1, evidence: [], entities: [], episodeIds: [], tags: {} });
    assert.equal(engine.projection.checkpointWal().status, 'checkpointed');
    assert.equal((await stat(join(root, 'memory.sqlite-wal'))).size, 0);
  }
  assert.equal(engine.projection.stats().facts, 30);
});

test('pinned-reader pressure pauses daemon claims until a later safe checkpoint', async t => {
  const { processAvailable } = await import('../src/curation/pipeline.ts');
  const root = await mkdtemp(join(tmpdir(), 'wal-pressure-'));
  const engine = open(root);
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  engine.projection.checkpointWal();
  const reader = await child(root, 'reader');
  try {
    engine.projection.db.exec('CREATE TABLE test_wal_pressure(payload BLOB); INSERT INTO test_wal_pressure VALUES (zeroblob(9437184))');
    assert.equal(engine.projection.walPublicationPaused(), true);
    const before = engine.curation.stats();
    assert.deepEqual(await processAvailable(engine, new Map(), 'pressure', { maxAttempts: 1, maxInputChars: 8000, budget: { maxCallsPerDay: 1, maxTokensPerDay: 8000 } }), []);
    assert.deepEqual(engine.curation.stats(), before);
  } finally { await kill(reader); }
  assert.equal(engine.projection.walPublicationPaused(), false);
  assert.equal((await stat(join(root, 'memory.sqlite-wal'))).size, 0);
});
