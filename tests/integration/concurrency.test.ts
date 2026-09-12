import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../../src/engine.ts';
import { TestEmbeddingProvider } from '../helpers.ts';

test('independent Pi sessions write separate append streams into one WAL projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-concurrent-'));
  const first = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 'first', provider: new TestEmbeddingProvider() });
  const second = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 'second', provider: new TestEmbeddingProvider() });
  t.after(async () => { await first.dispose(); await second.dispose(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([
    first.recordFact({ kind: 'decision', statement: 'Use SQLite for memory', entities: [], evidence: [], episodeIds: [], confidence: 0.6, tags: {} }),
    second.recordFact({ kind: 'failure', statement: 'OAuth login failed during refresh', entities: [], evidence: [], episodeIds: [], confidence: 0.6, tags: {} }),
  ]);
  assert.equal(first.projection.stats().facts, 2);
  assert.equal((await first.journal.readAll()).length, 2);
  const rebuilt = await first.rebuild();
  assert.equal(rebuilt.events, 2);
  assert.equal(first.projection.stats().facts, 2);
});
