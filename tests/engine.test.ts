import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine, hostEvidence } from '../src/engine.ts';
import type { EmbeddingProvider } from '../src/vector/providers.ts';
import { TestEmbeddingProvider } from './helpers.ts';

class RecoveringEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'recovering-v1';
  readonly isLocal = true;
  available = false;
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!this.available) throw new Error('offline');
    return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
  }
}

test('records evidence-backed temporal facts and retrieves them through dense synonyms', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-engine-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const evidence = hostEvidence({ excerpt: 'migration test succeeded', sessionId: 's1' });
  const stored = await engine.recordFact({ kind: 'decision', statement: 'Use SQLite for durable project storage',
    subject: 'project storage', predicate: 'uses', object: 'SQLite', entities: [], evidence: [evidence], episodeIds: [],
    confidence: 0.95, validAt: '2026-01-01T00:00:00.000Z', tags: { area: 'storage' } });
  assert.equal(stored.fact.standing, 'supported');
  const recalled = await engine.search({ queries: ['database persistence'], dense: true, maxBytes: 4096 });
  assert.equal(recalled.items[0]?.id, stored.fact.id);
  assert.ok(recalled.items[0]?.reason.includes('dense'));
});

test('superseded temporal facts are excluded now but available before invalidation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-engine-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const old = await engine.recordFact({ kind: 'decision', statement: 'Deploy releases on Friday', entities: [], evidence: [], episodeIds: [],
    confidence: 0.6, validAt: '2025-01-01T00:00:00.000Z', invalidAt: '2099-01-01T00:00:00.000Z', tags: {} });
  await engine.resolveFact(old.fact.id, 'superseded', 'Schedule changed');
  assert.equal((await engine.search({ queries: ['deploy releases'], dense: false })).items.length, 0);
  const historical = await engine.search({ queries: ['deploy releases'], dense: false, asOf: '2025-06-01T00:00:00.000Z' });
  assert.equal(historical.items[0]?.id, old.fact.id);
  assert.ok(Date.parse(engine.projection.getFact(old.fact.id)?.invalidAt ?? '') < Date.parse('2099-01-01T00:00:00.000Z'));
});

test('dense outages leave lexical chunks available for an explicit backfill', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-engine-'));
  const provider = new RecoveringEmbeddingProvider();
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const indexed = await engine.index({ namespace: 'docs', externalId: 'offline', scopeId: 'p_test', scopeKind: 'project',
    source: 'test', kind: 'procedure', text: 'Recover the dense index after an outage.', version: 'v1',
    contentHash: '0'.repeat(64), observedAt: '2026-01-01T00:00:00.000Z', trust: 'host', metadata: {} });
  assert.deepEqual(indexed, { chunks: 1, embedded: 0, dense: false });
  provider.available = true;
  assert.equal(await engine.vector.backfill(), 1);
  assert.equal(await engine.vector.backfill(), 0);
  assert.equal((await engine.search({ queries: ['recover'], dense: true })).items[0]?.id, 'offline');
});

test('authority commit is lexically searchable without vector upsert', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-lex-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const fact = engine.composeFact({
    kind: 'decision', statement: 'Use north-datastore-alpha for durable project storage',
    entities: [], evidence: [], episodeIds: [], confidence: 0.9, tags: {},
  });
  engine.authorityTransaction(() => engine.commitAuthority({ type: 'fact.recorded', fact }));
  assert.equal(engine.projection.getFact(fact.id)?.statement, fact.statement);
  assert.ok(engine.projection.chunkCount({ namespace: 'memory', externalId: fact.id }) >= 1);
  const found = await engine.search({ queries: ['north-datastore-alpha'], dense: false });
  assert.equal(found.items[0]?.id, fact.id);
});

test('rebuild is locked and still reconstructs the projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-rebuild-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  await engine.recordFact({ kind: 'decision', statement: 'Use SQLite for memory', entities: [], evidence: [], episodeIds: [], confidence: 0.8, tags: {} });
  await writeFile(join(root, 'rebuild.lock'), '{}');
  await assert.rejects(engine.rebuild(), /already running/);
  await rm(join(root, 'rebuild.lock'), { force: true });
  const rebuilt = await engine.rebuild();
  assert.equal(rebuilt.documents, 1);
});

test('replay repairs an event committed before its projection and remains idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-engine-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  await engine.journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'missing', reason: 'crash-window' });
  assert.equal((await engine.replay()).events, 1);
  assert.equal((await engine.replay()).events, 0);
});
