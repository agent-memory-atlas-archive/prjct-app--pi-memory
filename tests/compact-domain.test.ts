import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projection } from '../src/storage/projection.ts';
import { CurationStore } from '../src/curation/store.ts';
import { claimMemoryOwner } from '../src/storage/migrations.ts';
import { CompactStore } from '../src/storage/compact-store.ts';
import { CompactCapacityError } from '../src/storage/compact-authority.ts';
import type { MemoryEvent, MemoryEventPayload } from '../src/contracts/events.ts';
import type { EvidenceRef } from '../src/contracts/evidence.ts';
import type { TemporalFact } from '../src/contracts/memory.ts';
import type { SourceDocument } from '../src/contracts/documents.ts';
import type { SourceIdentity } from '../src/curation/types.ts';
import { sha256 } from '../src/workspace/project-identity.ts';
import { documentKey } from '../src/contracts/documents.ts';

const READ_ME = documentKey({ namespace: 'project.docs', externalId: 'readme' });

const SCOPE = 'p_compact';
const NOW = Date.now();
const chain = { sequence: 0, previous: undefined as string | undefined };
const event = (payload: MemoryEventPayload, recordedAt: string): MemoryEvent => {
  const unsigned = {
    schemaVersion: 1 as const, id: `evt_${sha256(`${chain.sequence}\u0000${recordedAt}\u0000${JSON.stringify(payload)}`).slice(0, 8)}-0000-4000-8000-${sha256(recordedAt + String(chain.sequence)).slice(0, 12)}`,
    scopeId: SCOPE, writerId: 'writer_0123456789abcdef', sessionId: 'trace',
    sequence: chain.sequence + 1, recordedAt, ...(chain.previous ? { previousHash: chain.previous } : {}), payload,
  };
  const signed = { ...unsigned, eventHash: sha256(JSON.stringify(unsigned)) };
  chain.sequence = signed.sequence; chain.previous = signed.eventHash;
  return signed;
};

const evidence = (id: string, excerpt: string): EvidenceRef => ({
  id, origin: 'host_observation', provenance: 'native_observation', contentHash: sha256(excerpt),
  excerpt, observedAt: '2026-01-01T00:00:00.000Z',
});
const fact = (id: string, statement: string, extra: Partial<TemporalFact> = {}): TemporalFact => ({
  id, scopeId: SCOPE, kind: 'decision', statement, standing: 'supported', confidence: 0.9,
  recordedAt: '2026-01-02T00:00:00.000Z', evidence: [evidence(`ev_${id}`, `observed ${statement}`)],
  entities: [{ id: `ent_${id}`, scopeId: SCOPE, name: 'storage', type: 'component', aliases: ['db'] }],
  episodeIds: [], tags: { sourceAdapter: 'docs', sourceDocumentKey: 'docs:readme', sourceRevision: 'r1' }, ...extra,
});
const document = (externalId: string, text: string, extra: Partial<SourceDocument> = {}): SourceDocument => ({
  namespace: 'project.docs', externalId, scopeId: SCOPE, scopeKind: 'project', source: 'docs', kind: 'document',
  title: externalId, text, version: sha256(text), contentHash: sha256(text), observedAt: '2026-01-01T00:00:00.000Z',
  trust: 'imported', metadata: { path: externalId }, ...extra,
});
const identity = (revision: string, contentHash = sha256(revision)): SourceIdentity => ({
  adapter: 'docs', documentKey: READ_ME, namespace: 'project.docs', externalId: 'readme',
  revision, contentHash, kind: 'document', title: 'readme', observedAt: '2026-01-01T00:00:00.000Z',
  trust: 'imported', metadata: {},
});

type Backend = Readonly<{
  applyEvent(event: MemoryEvent): boolean;
  transaction(action: () => unknown): unknown;
  projection: any; curation: any; close(): Promise<void> | void;
}>;

const normalize = (backend: Backend) => {
  const facts = backend.projection.activeFacts(SCOPE, 1000).map((item: any) => backend.projection.getFact(item.id));
  const documents = [...backend.projection.eachActiveDocument()].map((item: any) => ({ ...item, chunks: backend.projection.chunkCount(item) }));
  const jobs = backend.curation.openJobs(1000);
  return {
    facts: JSON.parse(JSON.stringify(facts)), documents: JSON.parse(JSON.stringify(documents)),
    stats: backend.projection.stats().facts, activity: backend.projection.activity(),
    sync: backend.projection.syncStates(), gaps: backend.projection.sourceGaps(),
    jobs: JSON.parse(JSON.stringify(jobs)), curationStats: backend.curation.stats(NOW),
    fingerprint: backend.curation.fingerprint(READ_ME) ?? null,
    watermark: backend.curation.watermark('docs', READ_ME) ?? null,
    topic: backend.curation.topic('topic_storage') ?? null,
    coverage: backend.curation.coverage(READ_ME) ?? null,
    drafts: backend.curation.windowDrafts(READ_ME, 'r2'),
    dependents: backend.curation.dependents(READ_ME).slice().sort(),
    spend: backend.curation.spend(NOW),
    checkpoint: backend.projection.operationalCheckpoint(SCOPE, 's1') ?? null,
  };
};

const indexedBackend = async (t: TestContext): Promise<Backend> => {
  const root = await mkdtemp(join(tmpdir(), 'indexed-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projection = new Projection(join(root, 'memory.sqlite'));
  claimMemoryOwner(projection.db, SCOPE);
  const curation = new CurationStore(projection.db, join(root, 'memory.sqlite'));
  return {
    applyEvent: e => projection.apply(e),
    transaction: action => projection.transaction(action),
    projection, curation, close: () => { curation.close(); projection.close(); },
  };
};
const compactBackend = async (t: TestContext): Promise<Backend & { store: CompactStore }> => {
  const root = await mkdtemp(join(tmpdir(), 'compact-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CompactStore(join(root, 'memory.sqlite'), SCOPE);
  return { applyEvent: e => store.applyEvent(e), transaction: action => store.transaction(action),
    projection: store.projection, curation: store.curation, store, close: () => store.close() };
};

// One trace, both backends. Written as operations so a divergence is a real
// behavioral difference, not a difference in how the test drives each store.
const semanticTrace = (backend: Backend) => {
  backend.applyEvent(event({ type: 'document.upserted', document: document('readme', 'SQLite is the durable project authority. '.repeat(4)) }, '2026-01-01T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_a', 'Storage is SQLite per project.', { validAt: '2026-01-01T00:00:00.000Z' }) }, '2026-01-02T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_b', 'Vectors are derived, not authority.', { recordedAt: '2026-01-03T00:00:00.000Z' }) }, '2026-01-02T02:00:00.000Z'));
  backend.applyEvent(event({ type: 'episode.recorded', episode: { id: 'ep_1', scopeId: SCOPE, kind: 'learning', summary: 'ran tests',
    observedAt: '2026-01-02T02:30:00.000Z', source: 'host', evidence: [evidence('ev_ep', 'npm test passed')] } }, '2026-01-02T02:30:00.000Z'));
  backend.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_c', 'Storage is one SQLite file per project.',
    { supersedes: ['mem_a'], validAt: '2026-02-01T00:00:00.000Z', kind: 'correction', recordedAt: '2026-01-04T00:00:00.000Z' }) }, '2026-02-01T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'fact.resolved', factId: 'mem_b', standing: 'contradicted', rationale: 'measured otherwise' }, '2026-02-02T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'retrieval.feedback', factId: 'mem_c', signal: 'helpful', queryHash: sha256('storage') }, '2026-02-03T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'retrieval.feedback', factId: 'mem_c', signal: 'used', queryHash: sha256('storage') }, '2026-02-03T02:00:00.000Z'));
  backend.applyEvent(event({ type: 'document.upserted', document: document('obsolete', 'Superseded operational note.') }, '2026-02-04T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'document.deleted', namespace: 'project.docs', externalId: 'obsolete', reason: 'withdrawn upstream' }, '2026-02-05T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'curation.batch.commit', batchId: 'batch_1', sourceRevision: 'r2',
    facts: [fact('mem_d', 'Curated publication is atomic.', { recordedAt: '2026-01-05T00:00:00.000Z' })],
    documents: [document('topic_storage', 'Storage topic summary.', { namespace: 'memory.topic', externalId: 'topic_storage' })],
    resolves: [{ factId: 'mem_c', standing: 'needs_review', rationale: 'needs another source' }] }, '2026-02-06T01:00:00.000Z'));
  backend.applyEvent(event({ type: 'gc.compacted', removed: [documentKey({ namespace: 'project.docs', externalId: 'obsolete' })], retained: 3, generation: 'gen_1' }, '2026-02-07T01:00:00.000Z'));
  backend.projection.recordActivity({ turns: 3, tokens: 1200, inserts: 2 }, NOW);
  backend.projection.recordSync('docs', { at: NOW, discovered: 4, indexed: 4, ok: true });
  backend.projection.recordSync('broken', { at: NOW, discovered: 0, indexed: 0, ok: false, detail: 'unreachable' });
  backend.projection.upsertOperationalCheckpoint(SCOPE, 's1', '{"goal":"first"}', 1_000);
  backend.projection.upsertOperationalCheckpoint(SCOPE, 's1', '{"goal":"stale"}', 500);
  backend.projection.upsertOperationalCheckpoint(SCOPE, 's1', '{"goal":"second"}', 2_000);
};

const curationTrace = (backend: Backend) => {
  const store = backend.curation;
  const at = NOW;
  store.upsertFingerprint(identity('r1'), at);
  const first = store.enqueue({ id: 'job_one', scopeId: SCOPE, adapter: 'docs', documentKey: READ_ME, action: 'analyze', inputRevision: 'r1', contentHash: sha256('r1') }, at);
  const claimed = store.claim('owner-a', 60_000, at);
  store.fail(claimed!.id, 'owner-a', 'analyzer', 'transient analyzer failure', at + 30_000, false, at + 1);
  const retried = store.claim('owner-a', 1_000, at + 40_000);
  store.release(retried!.id, 'owner-a', at + 41_000);
  const stolen = store.claim('owner-b', 60_000, at + 90_000);
  store.renew(stolen!.id, 'owner-b', 60_000, at + 91_000);
  store.blockOpen('budget', 'daily budget exhausted', at + 92_000);
  store.unblock('budget', at + 93_000);
  store.reserveCall({ maxCallsPerDay: 2, maxTokensPerDay: 1_000 }, at, 100);
  store.reserveCall({ maxCallsPerDay: 2, maxTokensPerDay: 1_000 }, at, 100);
  store.reserveCall({ maxCallsPerDay: 2, maxTokensPerDay: 1_000 }, at, 100);
  store.recordSpend({ outputTokens: 42, embeddingCalls: 1 }, at);
  store.writeTopic({ id: 'topic_storage', scopeId: SCOPE, title: 'Storage', summary: 'Storage summary', factIds: ['mem_c'] }, 0, at);
  store.writeTopic({ id: 'topic_storage', scopeId: SCOPE, title: 'Ignored', summary: 'stale revision', factIds: [] }, 0, at);
  const batch = store.acceptBatch(stolen!, identity('r1'), 'topic_storage', 1, { factIds: ['mem_d'], documents: [{ title: 'Storage', text: 'Storage summary v2' }] }, 'owner-b', at + 94_000);
  store.commitBatch(batch!, stolen!, identity('r1'), 'topic_storage', 'owner-b');
  store.sealCommitted(batch!, stolen!, identity('r1'), 'topic_storage', 'owner-b', at + 95_000);
  store.finishPublish(batch!, stolen!, identity('r1'), 'topic_storage', at + 96_000, true);
  store.setCoverage(READ_ME, 28, 84, at);
  store.saveWindowDraft(READ_ME, 'r2', 0, ['mem_d'], ['qualified'], 'draft summary');
  store.saveWindowDraft(READ_ME, 'r2', 28, ['mem_e'], [], 'second window');
  store.linkFact('mem_d', identity('r1'));
  store.upsertFingerprint(identity('r2'), at + 97_000);
  store.discardOpenJobs(READ_ME, 'r2', at + 98_000);
  const next = store.enqueue({ id: 'job_two', scopeId: SCOPE, adapter: 'docs', documentKey: READ_ME, action: 'analyze', inputRevision: 'r2', contentHash: sha256('r2') }, at + 99_000);
  const held = store.claim('owner-c', 60_000, at + 100_000);
  store.finishWindow(held!.id, 'owner-c', READ_ME, 'docs', 'r2', sha256('r2'), SCOPE, 28, 84, true, undefined, at + 101_000);
  const cont = store.claim('owner-c', 60_000, at + 102_000);
  store.finishWindow(cont!.id, 'owner-c', READ_ME, 'docs', 'r2', sha256('r2'), SCOPE, 84, 84, false, undefined, at + 103_000);
  const repeat = store.enqueue({ id: first.id, scopeId: SCOPE, adapter: 'docs', documentKey: READ_ME, action: 'analyze', inputRevision: 'r1', contentHash: sha256('r1') }, at + 104_000);
  const claimedRepeat = store.claim('owner-d', 60_000, at + 105_000);
  store.finish(claimedRepeat!.id, 'owner-x', 'published', 'out', at + 106_000, true);
  store.finish(claimedRepeat!.id, 'owner-d', 'no_change', undefined, at + 107_000, true);
  return { first, repeat, next };
};

test('compact and indexed backends produce identical logical state for a full semantic lifecycle', async t => {
  const [indexed, compact] = [await indexedBackend(t), await compactBackend(t)];
  chain.sequence = 0; chain.previous = undefined;
  const events: MemoryEvent[] = [];
  const recording = { applyEvent: (e: MemoryEvent) => { events.push(e); return indexed.applyEvent(e); } };
  semanticTrace({ ...indexed, ...recording });
  for (const e of events) compact.applyEvent(e);
  compact.projection.recordActivity({ turns: 3, tokens: 1200, inserts: 2 }, NOW);
  compact.projection.recordSync('docs', { at: NOW, discovered: 4, indexed: 4, ok: true });
  compact.projection.recordSync('broken', { at: NOW, discovered: 0, indexed: 0, ok: false, detail: 'unreachable' });
  compact.projection.upsertOperationalCheckpoint(SCOPE, 's1', '{"goal":"first"}', 1_000);
  compact.projection.upsertOperationalCheckpoint(SCOPE, 's1', '{"goal":"stale"}', 500);
  compact.projection.upsertOperationalCheckpoint(SCOPE, 's1', '{"goal":"second"}', 2_000);
  assert.deepEqual(normalize(compact), normalize(indexed));
  assert.equal(compact.applyEvent(events[0]!), false, 'duplicate events are idempotent');
  assert.throws(() => compact.projection.operationalCheckpoint('p_other', 's1'), /does not own/iu);
  assert.throws(() => compact.projection.upsertOperationalCheckpoint('p_other', 's1', '{}', 9_000), /does not own/iu);
  await indexed.close(); await compact.close();
});

test('compact and indexed backends produce identical curation lifecycle state', async t => {
  const [indexed, compact] = [await indexedBackend(t), await compactBackend(t)];
  const a = curationTrace(indexed);
  const b = curationTrace(compact);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  assert.deepEqual(normalize(compact).jobs, normalize(indexed).jobs);
  assert.deepEqual(normalize(compact).curationStats, normalize(indexed).curationStats);
  for (const id of [a.first.id, a.next.id, a.repeat.id]) assert.deepEqual(JSON.parse(JSON.stringify(compact.curation.getJob(id))), JSON.parse(JSON.stringify(indexed.curation.getJob(id))), id);
  for (const key of ['fingerprint', 'watermark', 'topic', 'coverage', 'drafts', 'dependents', 'spend'] as const) {
    assert.deepEqual((normalize(compact) as any)[key], (normalize(indexed) as any)[key], key);
  }
  compact.curation.markWithdrawn(READ_ME, 1_767_225_700_000);
  indexed.curation.markWithdrawn(READ_ME, 1_767_225_700_000);
  assert.equal(compact.curation.fingerprint(READ_ME), undefined);
  assert.deepEqual(compact.curation.adapterFingerprints('docs'), indexed.curation.adapterFingerprints('docs'));
  assert.equal(compact.curation.fingerprintOwner(READ_ME), indexed.curation.fingerprintOwner(READ_ME));
  await indexed.close(); await compact.close();
});

test('compact history, restart and rebuild recover from canonical SQLite with no journal files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compact-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  chain.sequence = 0; chain.previous = undefined;
  const store = new CompactStore(join(root, 'memory.sqlite'), SCOPE);
  const events: MemoryEvent[] = [];
  semanticTrace({ applyEvent: e => { events.push(e); return store.applyEvent(e); }, transaction: a => store.transaction(a),
    projection: store.projection, curation: store.curation, close: () => undefined });
  curationTrace({ applyEvent: e => store.applyEvent(e), transaction: a => store.transaction(a), projection: store.projection, curation: store.curation, close: () => undefined });
  const before = normalize({ applyEvent: () => false, transaction: a => a(), projection: store.projection, curation: store.curation, close: () => undefined });
  store.close();
  assert.deepEqual(await readdir(root).then(entries => entries.filter(name => !name.startsWith('memory.sqlite'))), []);
  const reopened = new CompactStore(join(root, 'memory.sqlite'), SCOPE);
  const view = { applyEvent: (e: MemoryEvent) => reopened.applyEvent(e), transaction: (a: any) => reopened.transaction(a), projection: reopened.projection, curation: reopened.curation, close: () => undefined };
  assert.deepEqual(normalize(view), before, 'restart from SQLite alone');
  assert.deepEqual(reopened.history().map(e => e.id), events.map(e => e.id));
  assert.deepEqual(reopened.history().map(e => e.eventHash), events.map(e => e.eventHash));
  assert.deepEqual(await reopened.replay(), { events: 0, documents: 0 });
  assert.deepEqual(normalize(view), before, 'replay is idempotent');
  assert.equal((await reopened.rebuild()).events, events.length);
  assert.deepEqual(normalize(view), before, 'rebuild reproduces the same logical state');
  reopened.close();
});

test('nested compact operations commit once, roll back completely and stay inside the tiny byte budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compact-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'memory.sqlite');
  chain.sequence = 0; chain.previous = undefined;
  const store = new CompactStore(path, SCOPE);
  const footprint = async () => (await Promise.all([path, `${path}-wal`, `${path}-shm`].map(p => stat(p).then(i => i.size, () => 0)))).reduce((a, b) => a + b, 0);
  const revisionBefore = store.revision();
  store.transaction(() => {
    store.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_x', 'Nested writes share one commit.') }, '2026-03-01T00:00:00.000Z'));
    store.curation.upsertFingerprint(identity('r9'), NOW);
    store.curation.enqueue({ id: 'job_nested', scopeId: SCOPE, adapter: 'docs', documentKey: READ_ME, action: 'analyze', inputRevision: 'r9', contentHash: sha256('r9') }, NOW);
  });
  assert.equal(store.revision(), revisionBefore + 1, 'one authority revision for the whole group');
  assert.throws(() => store.transaction(() => {
    store.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_y', 'Rolled back fact.') }, '2026-03-02T00:00:00.000Z'));
    throw new Error('trace failure');
  }), /trace failure/);
  assert.equal(store.revision(), revisionBefore + 1, 'a failed group commits nothing');
  assert.equal(store.projection.getFact('mem_y'), undefined);
  assert.equal(store.history().some(e => JSON.stringify(e.payload).includes('mem_y')), false);
  assert.equal(store.projection.getFact('mem_x')?.statement, 'Nested writes share one commit.');
  for (const index of Array.from({ length: 20 }, (_, i) => i)) {
    store.applyEvent(event({ type: 'fact.recorded', fact: fact(`mem_n${index}`, `Durable published knowledge number ${index}.`) }, `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
    assert.ok(await footprint() < 68857, `peak live at ${index}`);
    store.checkpoint();
    assert.ok(await footprint() < 68857, `quiescent at ${index}`);
  }
  store.close();
  assert.ok(await footprint() < 68857, 'closed');
  const reopened = new CompactStore(path, SCOPE);
  assert.ok(await footprint() < 68857, 'reopened');
  assert.equal(reopened.projection.activeFacts(SCOPE, 1000).length, 21);
  reopened.close();
});

test('capacity overflow refuses before mutation and loses no committed job or history event', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compact-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  chain.sequence = 0; chain.previous = undefined;
  const store = new CompactStore(join(root, 'memory.sqlite'), SCOPE);
  store.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_keep', 'Retained before overflow.') }, '2026-05-01T00:00:00.000Z'));
  store.curation.enqueue({ id: 'job_keep', scopeId: SCOPE, adapter: 'docs', documentKey: READ_ME, action: 'analyze', inputRevision: 'r1', contentHash: sha256('r1') }, NOW);
  const revision = store.revision();
  const huge = Array.from({ length: 400 }, (_, i) => `Distinct durable statement ${i} ${sha256(String(i))}`).join(' ');
  assert.throws(() => store.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_huge', huge) }, '2026-05-02T00:00:00.000Z')), CompactCapacityError);
  assert.equal(store.revision(), revision);
  assert.equal(store.projection.getFact('mem_huge'), undefined);
  assert.equal(store.projection.getFact('mem_keep')?.statement, 'Retained before overflow.');
  assert.equal(store.curation.getJob('job_keep')?.status, 'pending');
  assert.equal(store.history().length, 1);
  assert.equal(store.promotionRequired(), true);
  store.close();
});

test('vectors, chunk views, graph neighbours and GC selection match the indexed backend', async t => {
  const [indexed, compact] = [await indexedBackend(t), await compactBackend(t)];
  chain.sequence = 0; chain.previous = undefined;
  const events: MemoryEvent[] = [];
  semanticTrace({ applyEvent: e => { events.push(e); return indexed.applyEvent(e); }, transaction: a => indexed.transaction(a),
    projection: indexed.projection, curation: indexed.curation, close: () => undefined });
  for (const e of events) compact.applyEvent(e);
  const key = (id: string) => documentKey({ namespace: 'memory', externalId: id });
  const chunkIds = (backend: Backend) => [...backend.projection.eachActiveDocument()]
    .flatMap((doc: any) => backend.projection === compact.projection
      ? Object.keys((compact.store as any).state().chunks).filter(id => (compact.store as any).state().chunks[id].documentKey === documentKey(doc))
      : backend.projection.db.prepare('SELECT id FROM chunks WHERE document_key=? ORDER BY ordinal').all(documentKey(doc)).map((row: any) => String(row.id)));
  const [indexedChunks, compactChunks] = [chunkIds(indexed).sort(), chunkIds(compact).sort()];
  assert.deepEqual(compactChunks, indexedChunks, 'chunk identities are derived identically');
  const vector = Array.from({ length: 16 }, (_, i) => (i === 3 ? 1 : 0));
  for (const backend of [indexed, compact]) backend.projection.storeVectors(indexedChunks.slice(0, 3).map(id => ({ chunkId: id, vector })), 'test-model');
  assert.equal(compact.projection.stats().vectors, indexed.projection.stats().vectors);
  assert.deepEqual(compact.projection.chunks(indexedChunks.slice(0, 2)).map((c: any) => [c.id, c.document.externalId]),
    indexed.projection.chunks(indexedChunks.slice(0, 2)).map((c: any) => [c.id, c.document.externalId]));
  assert.deepEqual([...compact.projection.eachDocumentHash()], [...indexed.projection.eachDocumentHash()]);
  assert.deepEqual(compact.projection.graphNeighbors(['mem_c'], 10).map((f: any) => f.id),
    indexed.projection.graphNeighbors(['mem_c'], 10).map((f: any) => f.id));
  const later = Date.parse('2027-01-01T00:00:00.000Z');
  assert.deepEqual(compact.projection.gcCandidates(later).slice().sort(), indexed.projection.gcCandidates(later).slice().sort());
  const reachable = new Set([key('mem_c')]);
  assert.deepEqual(compact.projection.gcProjection(reachable).slice().sort(), indexed.projection.gcProjection(reachable).slice().sort());
  assert.equal(compact.projection.stats().facts, indexed.projection.stats().facts);
  assert.deepEqual([...compact.projection.eachActiveDocument()], [...indexed.projection.eachActiveDocument()]);
  await indexed.close(); await compact.close();
});

test('a second compact client observes committed state and cannot overwrite it blindly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compact-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  chain.sequence = 0; chain.previous = undefined;
  const first = new CompactStore(join(root, 'memory.sqlite'), SCOPE);
  const second = new CompactStore(join(root, 'memory.sqlite'), SCOPE);
  first.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_first', 'Committed by the first client.', { recordedAt: '2026-06-01T00:00:00.000Z' }) }, '2026-06-01T00:00:00.000Z'));
  assert.equal(second.projection.getFact('mem_first')?.statement, 'Committed by the first client.');
  second.applyEvent(event({ type: 'fact.recorded', fact: fact('mem_second', 'Committed by the second client.', { recordedAt: '2026-06-02T00:00:00.000Z' }) }, '2026-06-02T00:00:00.000Z'));
  assert.equal(first.projection.getFact('mem_second')?.statement, 'Committed by the second client.');
  assert.deepEqual(first.history().map(e => e.id), second.history().map(e => e.id));
  assert.equal(first.revision(), second.revision());
  first.close(); second.close();
});
