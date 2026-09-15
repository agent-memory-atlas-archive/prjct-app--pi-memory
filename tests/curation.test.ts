import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedAnalyzer } from '../src/curation/analyzer.ts';
import { processAvailable } from '../src/curation/pipeline.ts';
import { CurationStore, jobIdFor } from '../src/curation/store.ts';
import { isCuratedNamespace, type AnalysisProposal, type EvidenceBundle } from '../src/curation/types.ts';
import { checkpointAndEnqueueLegacy } from '../src/curation/migrate.ts';
import { MemoryEngine } from '../src/engine.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const sourceText = 'Decision: use SQLite for durable local storage. Proposal: consider a hosted database later. Correction: do not treat drafts as approved.';

const proposalFor = (bundle: EvidenceBundle): AnalysisProposal => ({
  noChange: false,
  topic: { id: 'storage', title: 'Storage', summary: 'SQLite is the durable local store; a hosted database remains a proposal.' },
  facts: [
    {
      action: 'create', kind: 'decision', epistemic: 'decision',
      statement: 'Use SQLite for durable local storage.', confidence: 0.8, standing: 'needs_review',
      semanticKey: 'storage.sqlite', excerpt: 'Decision: use SQLite for durable local storage.',
      sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace, externalId: bundle.identity.externalId,
        revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
    },
    {
      action: 'create', kind: 'fact', epistemic: 'proposal',
      statement: 'A hosted database is a proposal, not an approved decision.', confidence: 0.7, standing: 'supported',
      semanticKey: 'storage.hosted.proposal', excerpt: 'Proposal: consider a hosted database later.',
      sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace, externalId: bundle.identity.externalId,
        revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
    },
  ],
  conflicts: ['Hosted database remains unresolved against the SQLite decision.'],
});

const open = async (t: { after(fn: () => unknown): void }) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-curate-'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'policy.json'), JSON.stringify({ id: 'storage-policy', text: sourceText, observedAt: '2026-01-01T00:00:00.000Z' }));
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const registry = new SourceRegistry();
  const adapter = new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source, mapping: { namespace: 'policies' } });
  registry.register(adapter);
  return { root, source, engine, registry, adapter };
};

const processAll = (engine: MemoryEngine, registry: SourceRegistry, calls: { n: number }) =>
  processAvailable(engine, new Map([['policies', registry.get('policies')!]]), 'worker-a', {
    analyzer: scriptedAnalyzer(bundle => {
      calls.n += 1;
      return proposalFor(bundle);
    }),
    maxAttempts: 5, maxInputChars: 8_000, budget: { maxCallsPerDay: 50, maxTokensPerDay: 50_000 },
  });

test('source sync enqueues analysis and does not copy raw bodies into the journal', async t => {
  const { engine, registry, source } = await open(t);
  const result = await registry.sync(async () => engine, 'policies');
  assert.equal(result.indexed, 1);
  assert.equal(result.queued, 1);
  assert.equal(engine.projection.stats().documents, 0);
  const body = await readFile(join(source, 'policy.json'), 'utf8');
  for (const event of await engine.journal.readAll()) {
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(sourceText), false, 'queue/journal must not persist the source body');
    assert.equal(serialized.includes(body), false);
  }
});

test('a worker publishes curated facts and topic text only, then idles without model calls', async t => {
  const { engine, registry } = await open(t);
  await registry.sync(async () => engine, 'policies');
  const calls = { n: 0 };
  const first = await processAll(engine, registry, calls);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.outcome, 'published');
  assert.equal(calls.n, 1);
  const facts = engine.projection.activeFacts('p_test');
  assert.equal(facts.some(fact => fact.statement.includes('SQLite')), true);
  assert.equal(facts.find(fact => fact.tags.epistemic === 'proposal')?.standing, 'needs_review');
  assert.equal(facts.every(fact => fact.evidence[0]?.provenance === 'imported'), true);
  const topics = [...engine.projection.eachActiveDocument()].filter(document => document.namespace === 'memory.topic');
  assert.ok(topics.length >= 2, 'parent topic and semantic subtopics');
  assert.ok(topics.some(document => document.metadata.parent), 'subtopics must remain expandable under a parent topic');
  for (const document of engine.projection.eachActiveDocument()) {
    assert.equal(isCuratedNamespace(document.namespace), true);
    assert.equal(document.text.includes(sourceText), false);
  }
  const recalled = await engine.search({ queries: ['SQLite storage'], dense: false, namespaces: ['memory', 'memory.topic'] });
  assert.ok(recalled.items.some(item => item.statement.includes('SQLite')));
  const secondSync = await registry.sync(async () => engine, 'policies');
  assert.equal(secondSync.queued, 0);
  const second = await processAll(engine, registry, calls);
  assert.equal(second.length, 0);
  assert.equal(calls.n, 1);
});

test('changed sources invalidate dependents and competing claims cannot publish stale work', async t => {
  const { engine, registry, source } = await open(t);
  await registry.sync(async () => engine, 'policies');
  await processAll(engine, registry, { n: 0 });
  const original = engine.projection.activeFacts('p_test').find(fact => fact.tags.semanticKey === 'storage.sqlite')!;
  await writeFile(join(source, 'policy.json'), JSON.stringify({
    id: 'storage-policy', text: `${sourceText} Decision: drafts are not approved.`, observedAt: '2026-02-01T00:00:00.000Z',
  }));
  const changed = await registry.sync(async () => engine, 'policies');
  assert.ok(changed.queued >= 1);
  await processAll(engine, registry, { n: 0 });
  const updated = engine.projection.getFact(original.id)!;
  assert.equal(updated.standing === 'needs_review' || updated.standing === 'superseded' || updated.standing === 'contradicted', true);

  const store = engine.curation;
  const pending = store.openJobs()[0] ?? store.enqueue({
    id: jobIdFor('p_test', 'analyze', original.tags.semanticKey, 'stale-rev'),
    scopeId: 'p_test', adapter: 'policies', documentKey: store.adapterFingerprints('policies')[0]!.documentKey,
    action: 'analyze', inputRevision: 'deadbeef', contentHash: '0'.repeat(64),
  });
  const first = store.claim('worker-a', 60_000);
  const second = store.claim('worker-b', 60_000);
  assert.ok(first);
  assert.equal(second === undefined || second.id !== first.id, true);
  store.fail(first.id, 'worker-a', 'stale', 'revision moved', Date.now() + 1000);
  const watermark = store.watermark('policies', first.documentKey);
  assert.equal(watermark?.revision === 'deadbeef', false);
  void pending;
});

test('missing analyzer, exhausted budget and failed analysis do not advance watermarks', async t => {
  const { engine, registry } = await open(t);
  await registry.sync(async () => engine, 'policies');
  const adapters = new Map([['policies', registry.get('policies')!]]);
  const blocked = await processAvailable(engine, adapters, 'worker-a', {
    maxAttempts: 3, maxInputChars: 8_000, budget: { maxCallsPerDay: 50, maxTokensPerDay: 50_000 },
  });
  assert.equal(blocked[0]?.outcome, 'missing_model');
  assert.equal(engine.curation.stats().blocked, 1);
  assert.equal(engine.curation.watermark('policies', engine.curation.adapterFingerprints('policies')[0]!.documentKey), undefined);

  engine.curation.unblock('missing_model');
  const broke = await processAvailable(engine, adapters, 'worker-a', {
    analyzer: scriptedAnalyzer(() => { throw new Error('model exploded'); }),
    maxAttempts: 3, maxInputChars: 8_000, budget: { maxCallsPerDay: 50, maxTokensPerDay: 50_000 },
  });
  assert.equal(broke[0]?.outcome, 'analysis_failed');
  assert.equal(engine.curation.stats().failed, 1);
  assert.equal(engine.projection.stats().facts, 0);

  engine.curation.recordSpend({ calls: 50 });
  engine.curation.db.exec("UPDATE jobs SET status='pending', error_code=NULL, next_attempt_at=0, lease_owner=NULL, lease_until=NULL");
  const over = await processAvailable(engine, adapters, 'worker-a', {
    analyzer: scriptedAnalyzer(proposalFor),
    maxAttempts: 3, maxInputChars: 8_000, budget: { maxCallsPerDay: 50, maxTokensPerDay: 50_000 },
  });
  assert.equal(over[0]?.outcome, 'budget_exhausted');
  assert.equal(engine.projection.stats().facts, 0);
});

test('leases expire so a restarted worker can recover an interrupted job', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'curation.sqlite');
  const first = new CurationStore(path);
  first.enqueue({ id: 'job_one', scopeId: 'p_test', adapter: 'policies', documentKey: 'policies:x',
    action: 'analyze', inputRevision: 'r1', contentHash: '0'.repeat(64) });
  const claimed = first.claim('dead-worker', 1, 0);
  assert.equal(claimed?.status, 'claimed');
  first.close();
  const recovered = new CurationStore(path);
  const next = recovered.claim('live-worker', 1_000, 50);
  assert.equal(next?.leaseOwner, 'live-worker');
  recovered.finish(next!.id, 'live-worker', 'no_change', undefined, 50);
  assert.equal(recovered.getJob(next!.id)?.status, 'no_change');
  recovered.close();
});

test('legacy migration checkpoints raw copies and does not purge the journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-migrate-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  await engine.index({ namespace: 'policies', externalId: 'storage-policy', scopeId: 'p_test', scopeKind: 'project',
    source: 'test', kind: 'decision', text: sourceText, version: 'v1', contentHash: '0'.repeat(64),
    observedAt: '2026-01-01T00:00:00.000Z', trust: 'imported', metadata: {} });
  const report = await checkpointAndEnqueueLegacy(engine);
  assert.equal(report.enqueued, 1);
  assert.equal(report.rawJournalPreserved, true);
  assert.match(report.limitation, /still contain raw source bodies/);
  const events = await engine.journal.readAll();
  assert.equal(events.some(event => event.payload.type === 'document.upserted' && event.payload.document.text === sourceText), true);
  const checkpoints = (await readdir(root)).filter(name => name.startsWith('checkpoint-raw-'));
  assert.equal(checkpoints.length, 1);
  const names = await readdir(join(root, checkpoints[0]!));
  assert.ok(names.includes('memory.sqlite'));
  assert.equal(names.includes('index.sqlite'), false);
  assert.equal(names.includes('curation.sqlite'), false);
});
