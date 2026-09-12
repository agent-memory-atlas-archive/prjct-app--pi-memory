import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { runGc } from '../src/retention/gc.ts';
import { TestEmbeddingProvider } from './helpers.ts';

test('GC removes low-value rebuildable indexes but keeps append-only fact evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-gc-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const stored = await engine.recordFact({ kind: 'learning', statement: 'Temporary unverified observation with no later use', entities: [], evidence: [], episodeIds: [],
    confidence: 0.3, recordedAt: '2025-01-01T00:00:00.000Z', tags: {} });
  const gc = await runGc(engine, Date.parse('2026-03-01T00:00:00.000Z'));
  assert.equal(gc.removed, 1);
  assert.equal(engine.projection.stats().documents, 0);
  assert.equal(engine.projection.getFact(stored.fact.id)?.statement, stored.fact.statement);
  assert.equal((await engine.journal.readAll()).at(-1)?.payload.type, 'gc.compacted');
});
