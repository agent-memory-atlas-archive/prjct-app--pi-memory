import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { documentKey } from '../src/contracts/documents.ts';
import { MemoryEngine } from '../src/engine.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const record = { id: 'storage-policy', text: 'SQLite storage policy requires local backups.',
  observedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z' };

test('a validity-only source amendment expires the indexed answer at the exact cutoff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-validity-'));
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = { namespace: 'policies', externalId: record.id, scopeId: 'p_test', scopeKind: 'project' as const,
    source: 'policies', kind: 'policy', text: record.text, version: 'v1', contentHash: '0'.repeat(64),
    observedAt: record.observedAt, validFrom: record.validFrom, trust: 'host' as const, metadata: {} };
  await engine.index(document);
  const lookup = (asOf: string) => federatedSearch([engine], { queries: ['storage-policy'], dense: false, asOf });
  assert.equal((await lookup('2026-02-01T00:00:00.000Z')).items.length, 1);
  await engine.index({ ...document, validTo: '2026-02-01T00:00:00.000Z' });
  assert.equal((await lookup('2026-02-01T00:00:00.000Z')).items.length, 0);
  assert.equal((await lookup('2026-01-31T23:59:59.999Z')).items.length, 1);
});

test('complete source scans queue withdrawals, but broken or unavailable sources retain fingerprints with a gap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-retirement-'));
  const source = join(root, 'source');
  await mkdir(source);
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const registry = new SourceRegistry();
  registry.register(new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies' } }));
  const path = join(source, 'policy.json');
  await writeFile(path, JSON.stringify(record));
  await registry.sync(async () => engine, 'policies');
  const live = () => engine.curation.adapterFingerprints('policies');
  assert.equal(live().length, 1);
  await writeFile(path, '{"id":');
  const malformed = await registry.sync(async () => engine, 'policies');
  assert.ok(malformed.gaps.some(gap => /malformed/iu.test(gap)));
  assert.equal(malformed.removed, 0);
  assert.equal(live().length, 1);
  await rm(source, { recursive: true });
  const missingRoot = await registry.sync(async () => engine, 'policies');
  assert.equal(live().length, 1);
  assert.ok(missingRoot.gaps.length || missingRoot.removed === 0);
  await mkdir(source);
  const empty = await registry.sync(async () => engine, 'policies');
  assert.equal(empty.removed, 1);
  assert.equal(live().length, 0);
  await engine.rebuild();
  await writeFile(path, JSON.stringify(record));
  await registry.sync(async () => engine, 'policies');
  assert.equal(live().length, 1);
  await engine.rebuild();
  await rm(path);
  await registry.sync(async () => engine, 'policies');
  assert.equal(live().length, 0, 'rebuild must not invent source ownership; fingerprints survive in curation.sqlite');
});

test('future observations and facts cannot leak into an earlier query; declared validity is visible', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-time-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  await engine.index({ namespace: 'policies', externalId: 'future-policy', scopeId: 'p_test', scopeKind: 'project',
    source: 'test', kind: 'policy', text: record.text, version: 'v1', contentHash: '0'.repeat(64),
    observedAt: '2026-03-01T00:00:00.000Z', trust: 'host', metadata: {} });
  await engine.recordFact({ kind: 'decision', statement: 'SQLite storage policy requires local backups.', entities: [], evidence: [],
    episodeIds: [], confidence: 0.8, recordedAt: '2026-03-01T00:00:00.000Z', tags: {} });
  for (const dense of [false, true]) {
    assert.equal((await federatedSearch([engine], { queries: ['SQLite storage policy'], dense, asOf: '2026-02-01T00:00:00.000Z' })).items.length, 0);
    const found = await federatedSearch([engine], { queries: ['future-policy'], dense, asOf: '2026-03-01T00:00:00.000Z' });
    assert.equal(found.items[0]?.observedAt, '2026-03-01T00:00:00.000Z');
  }
});

test('a future-effective replacement preserves the old decision until the replacement starts, including graph recall', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-supersession-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const base = { kind: 'decision' as const, entities: [{ id: 'e_schedule', scopeId: 'p_test', name: 'Zephyr schedule', type: 'policy', aliases: [] }], evidence: [], episodeIds: [], confidence: 0.8, tags: {} };
  const old = await engine.recordFact({ ...base, statement: 'Zephyr deployment schedule uses Fridays', validAt: '2026-01-01T00:00:00.000Z' });
  const next = await engine.recordFact({ ...base, statement: 'Zephyr deployment schedule uses Mondays',
    recordedAt: '2026-02-01T00:00:00.000Z', validAt: '2026-03-01T00:00:00.000Z', supersedes: [old.fact.id] });
  for (const dense of [false, true]) {
    const before = await federatedSearch([engine], { queries: ['Zephyr deployment schedule'], dense, asOf: '2026-02-28T23:59:59.999Z' });
    assert.equal(before.items[0]?.id, old.fact.id);
    assert.equal(before.items[0]?.invalidAt, '2026-03-01T00:00:00.000Z');
    const after = await federatedSearch([engine], { queries: ['Zephyr deployment schedule'], dense, asOf: '2026-03-01T00:00:00.000Z' });
    assert.equal(after.items[0]?.id, next.fact.id);
    assert.ok(!after.items.some(item => item.id === old.fact.id));
  }
  assert.ok(engine.projection.graphNeighbors([next.fact.id], 10).some(fact => fact.id === old.fact.id));
  const resolved = engine.projection.getFact(old.fact.id)!;
  assert.ok(Date.parse(resolved.expiredAt!) > Date.parse('2026-02-01T00:00:00.000Z'), 'transaction time comes from the journal, not a backdated input');
  assert.ok(!engine.projection.gcCandidates(Date.parse(resolved.expiredAt!) + 1000)
    .includes(`memory:${Buffer.from(old.fact.id).toString('base64url')}`));
  await assert.rejects(engine.resolveFact(old.fact.id, 'supported', 'Undo'), /new fact/);
  await assert.rejects(engine.recordFact({ ...base, id: next.fact.id, statement: 'Do not silently rewrite immutable facts' }), /already exists/);
  await engine.rebuild();
  assert.equal(engine.projection.getFact(old.fact.id)?.invalidAt, '2026-03-01T00:00:00.000Z');
});

test('invalid source intervals fail closed and metadata-only amendments are durable and idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-source-dates-'));
  const source = join(root, 'source');
  await mkdir(source);
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const registry = new SourceRegistry();
  registry.register(new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies' } }));
  const path = join(source, 'policy.json');
  await writeFile(path, JSON.stringify(record));
  await registry.sync(async () => engine, 'policies');
  const fingerprint = () => engine.curation.adapterFingerprints('policies')[0];
  for (const validTo of ['garbage', '', '2025-01-01T00:00:00.000Z']) {
    await writeFile(path, JSON.stringify({ ...record, validTo }));
    await assert.rejects(registry.sync(async () => engine, 'policies'));
    assert.equal(fingerprint()?.validTo, undefined);
  }
  await writeFile(path, JSON.stringify({ ...record, title: 'Amended title', validTo: '2099-01-01T00:00:00.000Z' }));
  assert.equal((await registry.sync(async () => engine, 'policies')).indexed, 1);
  assert.equal((await registry.sync(async () => engine, 'policies')).indexed, 0);
  await engine.rebuild();
  assert.equal((await registry.sync(async () => engine, 'policies')).indexed, 0);
  assert.equal(fingerprint()?.title, 'Amended title');
  assert.equal(fingerprint()?.validFrom, record.validFrom);
  assert.equal(fingerprint()?.validTo, '2099-01-01T00:00:00.000Z');
});

test('the latest raw revision controls selection, and incomplete blobs do not cause retirement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-revisions-'));
  const source = join(root, 'source');
  const blobs = join(root, 'blobs');
  await mkdir(source); await mkdir(blobs);
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const registry = new SourceRegistry();
  registry.register(new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies', latestPerId: true, select: { keep: [{ field: 'stored', equals: true }] },
      contentFrom: { dir: blobs, field: 'blob' } } }));
  const first = { ...record, stored: true, blob: 'v1' };
  const next = { ...first, observedAt: '2026-02-01T00:00:00.000Z', blob: 'v2' };
  await writeFile(join(blobs, 'v1'), record.text);
  const path = join(source, 'policy.jsonl');
  await writeFile(path, JSON.stringify(first));
  await registry.sync(async () => engine, 'policies');
  await writeFile(path, [first, next].map(row => JSON.stringify(row)).join('\n'));
  const missing = await registry.sync(async () => engine, 'policies');
  assert.equal(missing.removed, 0);
  assert.ok(missing.gaps.length);
  assert.equal(engine.curation.adapterFingerprints('policies')[0]?.observedAt, record.observedAt);
  await writeFile(path, [first, { ...next, stored: false }].map(row => JSON.stringify(row)).join('\n'));
  assert.equal((await registry.sync(async () => engine, 'policies')).removed, 1);
  assert.equal(engine.curation.adapterFingerprints('policies')[0], undefined);
});

test('cancelling a planned decision leaves an empty interval and deleted facts do not reappear through the graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-cancelled-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const base = { kind: 'decision' as const, entities: [{ id: 'e_shared', scopeId: 'p_test', name: 'Zephyr', type: 'project', aliases: [] }],
    evidence: [], episodeIds: [], confidence: 0.8, tags: {} };
  const plan = await engine.recordFact({ ...base, statement: 'Zephyr launch policy starts next century', validAt: '2099-01-01T00:00:00.000Z' });
  await engine.resolveFact(plan.fact.id, 'contradicted', 'Cancelled before it starts');
  assert.equal(engine.projection.getFact(plan.fact.id)?.invalidAt, '2099-01-01T00:00:00.000Z');
  await engine.rebuild();
  assert.equal((await engine.search({ queries: ['Zephyr launch'], dense: false, asOf: '2099-01-01T00:00:00.000Z' })).items.length, 0);
  const seed = await engine.recordFact({ ...base, statement: 'Zephyr current policy' });
  await engine.remove('memory', plan.fact.id, 'Removed');
  assert.ok(!engine.projection.graphNeighbors([seed.fact.id], 10).some(fact => fact.id === plan.fact.id));
});

test('reconciliation is ownership-scoped; additive adapters never retire unseen documents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-ownership-'));
  const source = join(root, 'source');
  await mkdir(source);
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const manual = { namespace: 'policies', externalId: 'manual', scopeId: 'p_test', scopeKind: 'project' as const,
    source: 'manual', kind: 'policy', text: record.text, version: 'v1', contentHash: '0'.repeat(64), observedAt: record.observedAt,
    trust: 'user' as const, metadata: {} };
  await engine.index(manual);
  const registry = new SourceRegistry();
  registry.register(new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies' } }));
  const path = join(source, 'policy.json');
  await writeFile(path, JSON.stringify(record));
  await registry.sync(async () => engine, 'policies');
  const state = { documents: [{ ...manual, externalId: 'additive' }] };
  registry.register({ id: 'additive', scope: { kind: 'project', id: 'p_test' }, scan: async () => state.documents });
  await registry.sync(async () => engine, 'additive');
  state.documents = [];
  await registry.sync(async () => engine, 'additive');
  await rm(path);
  await registry.sync(async () => engine, 'policies');
  assert.ok(engine.projection.documentByKey(manual));
  assert.ok(engine.curation.fingerprintOwner(documentKey({ namespace: 'policies', externalId: 'additive' })) === 'additive'
    || engine.projection.documentByKey({ ...manual, externalId: 'additive' }));
  await writeFile(path, JSON.stringify({ ...record, id: 'additive' }));
  await assert.rejects(registry.sync(async () => engine, 'policies'), /another adapter/);
});

test('empty asOf and malformed publication times are rejected rather than interpreted as current or ancient', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-invalid-clock-'));
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(federatedSearch([engine], { queries: ['policy'], asOf: '' }), /asOf/);
  await assert.rejects(engine.search({ queries: ['policy'], asOf: '' }), /asOf/);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'policy.jsonl'), [record, { ...record, observedAt: 'garbage' }].map(row => JSON.stringify(row)).join('\n'));
  const adapter = new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies', latestPerId: true } });
  await assert.rejects(adapter.scan(), /observation timestamp/);
  await writeFile(join(source, 'policy.jsonl'), '[1,2]');
  const malformed = await adapter.snapshot();
  assert.equal(malformed.complete, false);
  assert.ok(malformed.gaps.some(gap => /not an object/iu.test(gap)));
});


test('direct vector upserts also apply same-version validity amendments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-vector-validity-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const document = { namespace: 'policies', externalId: 'policy', scopeId: 'p_test', scopeKind: 'project' as const,
    source: 'test', kind: 'policy', text: record.text, version: 'v1', contentHash: '0'.repeat(64),
    observedAt: record.observedAt, trust: 'host' as const, metadata: {} };
  await engine.vector.upsert(document);
  await engine.vector.upsert({ ...document, validTo: '2026-02-01T00:00:00.000Z' });
  assert.equal((await engine.search({ queries: ['SQLite storage policy'], asOf: '2026-02-01T00:00:00.000Z' })).items.length, 0);
});
