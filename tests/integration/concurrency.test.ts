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

test('a later same-writer event wins even when replay sees it first', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-order-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 'same', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = (text: string, hash: string) => ({ namespace: 'docs', externalId: 'a', scopeId: 'p_test', scopeKind: 'project' as const,
    source: 'test', kind: 'document', text, version: text, contentHash: hash.repeat(64), observedAt: '2026-01-01T00:00:00.000Z',
    trust: 'host' as const, metadata: {} });
  const first = await engine.journal.append({ type: 'document.upserted', document: document('old', '1') }, '2026-01-01T00:00:00.000Z');
  const second = await engine.journal.append({ type: 'document.upserted', document: document('new', '2') }, '2026-01-01T00:00:00.000Z');
  assert.deepEqual((await engine.journal.readAll()).map(event => event.id), [first.id, second.id]);
  await engine.rebuild();
  assert.equal(engine.projection.activeDocuments()[0]?.text, 'new');
});
