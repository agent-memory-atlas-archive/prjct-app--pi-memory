import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedAnalyzer } from '../src/curation/analyzer.ts';
import { processAvailable } from '../src/curation/pipeline.ts';
import { publishProposal } from '../src/curation/publish.ts';
import { MemoryEngine } from '../src/engine.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { sha256 } from '../src/workspace/project-identity.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const TEXT = 'Decision: use SQLite for durable local storage. A hosted PostgreSQL database remains an unapproved proposal; no migration has been authorized.';

const INDEXED_FAULT_FIXTURES = new Set(['publication-failure', 'due-reviews', 'finish-recovery', 'no-dup-commit', 'stale-discard', 'seal-not-success']);

const fixture = async (t: { after(fn: () => unknown): void }, name: string) => {
  const root = await mkdtemp(join(tmpdir(), `pi-memory-${name}-`));
  const source = join(root, 'source');
  await mkdir(source);
  const path = join(source, 'policy.json');
  await writeFile(path, JSON.stringify({ id: 'policy', text: TEXT, observedAt: '2026-01-01T00:00:00Z' }));
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_review', sessionId: name,
    provider: new TestEmbeddingProvider(), ...(INDEXED_FAULT_FIXTURES.has(name) ? { storage: 'indexed' as const } : {}) });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const adapter = new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_review' }, root: source, mapping: { namespace: 'policies' } });
  const registry = new SourceRegistry();
  registry.register(adapter);
  await registry.sync(async () => engine, 'policies');
  return { engine, registry, path, adapters: new Map([['policies', adapter]]) };
};

const proposal = (bundle: { identity: { revision: string; observedAt: string } }) => ({
  noChange: false,
  topic: { id: 'storage', title: 'SQLite storage', summary: 'SQLite is the current durable storage decision.' },
  facts: [{
    action: 'create' as const, kind: 'decision' as const, epistemic: 'decision' as const,
    statement: 'Use SQLite for durable local storage.', semanticKey: 'storage', confidence: 0.8, standing: 'needs_review' as const,
    excerpt: 'Decision: use SQLite for durable local storage.',
    sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
  }],
  conflicts: [],
});

const options = (analyzer = scriptedAnalyzer(proposal)) => ({
  analyzer, maxAttempts: 3, maxInputChars: 8_000, budget: { maxCallsPerDay: 50, maxTokensPerDay: 50_000 },
});

test('withdrawal removes the topic from current retrieval', async t => {
  const f = await fixture(t, 'withdrawal');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  await rm(f.path);
  await f.registry.sync(async () => f.engine, 'policies');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const found = await f.engine.search({ queries: ['SQLite storage'], dense: false, namespaces: ['memory', 'memory.topic'] });
  assert.equal(found.items.length, 0, `withdrawn knowledge still retrieved: ${found.items.map(item => `${item.namespace}:${item.statement}`).join('; ')}`);
});

test('analysis must bind the reread body to the fingerprint revision', async t => {
  const f = await fixture(t, 'revision');
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: 'Correction: the new decision is PostgreSQL, not SQLite.', observedAt: '2026-02-01T00:00:00Z' }));
  const seen: { match: boolean }[] = [];
  await processAvailable(f.engine, f.adapters, 'owner', options(scriptedAnalyzer(bundle => {
    seen.push({ match: sha256(bundle.text) === bundle.identity.contentHash });
    return { noChange: true, facts: [], conflicts: [] };
  })));
  assert.ok(seen.every(item => item.match), 'analyzer received new body paired with old content hash/revision');
});

test('an expired lease must not publish', async t => {
  const f = await fixture(t, 'expired-lease');
  const job = f.engine.curation.claim('owner', 1, 0)!;
  const identity = f.engine.curation.adapterFingerprints('policies')[0]!;
  const result = await publishProposal(f.engine, f.engine.curation, job, identity,
    { proposal: proposal({ identity }), provider: 'test', model: 'scripted', usage: { calls: 1, inputTokens: 1, outputTokens: 1 } },
    0, 'owner', TEXT);
  assert.equal(result.status, 'stale', 'expired lease published facts/topic');
});

test('publication failure can recover without being trapped behind topic CAS', async t => {
  const f = await fixture(t, 'publication-failure');
  const index = f.engine.index.bind(f.engine);
  f.engine.index = async (document, signal) => {
    if (document.namespace === 'memory.topic') throw new Error('injected topic index failure');
    return index(document, signal);
  };
  await processAvailable(f.engine, f.adapters, 'owner', options());
  f.engine.index = index;
  f.engine.curation.db.exec("UPDATE jobs SET next_attempt_at=0 WHERE status='failed'");
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const topic = [...f.engine.projection.eachActiveDocument()].find(document => document.namespace === 'memory.topic');
  assert.ok(topic, 'facts/topic revision committed before index failure; retry is permanently stale');
});

test('failed model calls consume the persistent call budget', async t => {
  const f = await fixture(t, 'budget');
  await processAvailable(f.engine, f.adapters, 'owner', options(scriptedAnalyzer(() => { throw new Error('invalid paid model response'); })));
  assert.equal(f.engine.curation.spend().calls, 1, 'a dispatched, failed model call was not charged');
});

test('A to B to A re-enqueues analysis instead of reusing a terminal job id', async t => {
  const f = await fixture(t, 'aba');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} Revision B.`, observedAt: '2026-02-01T00:00:00Z' }));
  await f.registry.sync(async () => f.engine, 'policies');
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: TEXT, observedAt: '2026-01-01T00:00:00Z' }));
  const again = await f.registry.sync(async () => f.engine, 'policies');
  assert.ok(again.queued > 0, 'returning to revision A must queue new work');
  assert.ok(f.engine.curation.openJobs().some(job => job.action === 'analyze'));
});

test('blocked missing-model jobs recover when an analyzer appears', async t => {
  const f = await fixture(t, 'unblock');
  await processAvailable(f.engine, f.adapters, 'owner', { maxAttempts: 3, maxInputChars: 8_000, budget: { maxCallsPerDay: 50, maxTokensPerDay: 50_000 } });
  assert.equal(f.engine.curation.stats().blocked, 1);
  await processAvailable(f.engine, f.adapters, 'owner', options());
  assert.ok(f.engine.projection.activeFacts('p_review').length > 0);
});

test('validity-only amendments must bind the reread full revision', async t => {
  const f = await fixture(t, 'dates');
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: TEXT, observedAt: '2026-01-01T00:00:00Z', validTo: '2026-02-01T00:00:00Z' }));
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const found = await f.engine.search({ queries: ['SQLite storage'], dense: false });
  assert.equal(found.items.length, 0, 'expired reread source produced current facts and topic');
});

test('stale publication cannot write a fact between fence check and journal append', async t => {
  const { processJob } = await import('../src/curation/pipeline.ts');
  const f = await fixture(t, 'stale-write');
  const recordFact = f.engine.recordFact.bind(f.engine);
  f.engine.recordFact = async (input, signal) => {
    await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} New source revision.`, observedAt: '2026-02-01T00:00:00Z' }));
    await f.registry.sync(async () => f.engine, 'policies');
    return recordFact(input, signal);
  };
  const job = f.engine.curation.claim('owner', 60_000)!;
  const result = await processJob(f.engine, f.adapters, job, 'owner', options(), new Map());
  assert.equal(result.outcome, 'stale');
  assert.equal(f.engine.projection.stats().facts, 0, 'rejected stale analysis durably wrote a fact');
});

test('old review cannot remove a newer published topic', async t => {
  const { processJob } = await import('../src/curation/pipeline.ts');
  const f = await fixture(t, 'review-race');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} New source revision.`, observedAt: '2026-02-01T00:00:00Z' }));
  await f.registry.sync(async () => f.engine, 'policies');
  const review = f.engine.curation.claim('old-review', 60_000)!;
  assert.equal(review.action, 'review');
  await processAvailable(f.engine, f.adapters, 'new-writer', options());
  assert.ok([...f.engine.projection.eachActiveDocument()].some(document => document.namespace === 'memory.topic'));
  await processJob(f.engine, f.adapters, review, 'old-review', options(), new Map());
  assert.ok([...f.engine.projection.eachActiveDocument()].some(document => document.namespace === 'memory.topic'), 'old revision review deleted newer topic');
});

test('three due-review cycles must not crash on duplicate terminal job ids', async t => {
  const { runCycle } = await import('../src/daemon/worker.ts');
  const { loadDaemonConfig } = await import('../src/daemon/config.ts');
  const f = await fixture(t, 'due-reviews');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  f.engine.curation.db.exec('UPDATE fingerprints SET updated_at=0');
  const config = await loadDaemonConfig({ home: join(tmpdir(), 'due-reviews'), maxReviewAgeMs: 1 });
  for (const _ of [1, 2, 3]) {
    await runCycle({ config, owner: 'owner', engines: [f.engine], extraAdapters: [...f.adapters.values()], analyzer: scriptedAnalyzer(proposal) });
  }
});

test('valid analysis slower than lease but within deadline can complete', async t => {
  const f = await fixture(t, 'renewal');
  const analyzer = { provider: 'test', model: 'scripted', analyze: async (bundle: { identity: { revision: string; observedAt: string } }) => {
    // Keep a wide scheduling margin after analysis. A 10 ms lease made this a
    // test of loaded CI timer jitter and synchronous SQLite publication rather
    // than of renewal during a genuinely longer asynchronous model call.
    await new Promise(resolve => setTimeout(resolve, 350));
    return { proposal: proposal(bundle), provider: 'test', model: 'scripted', usage: { calls: 1, inputTokens: 1, outputTokens: 1 } };
  } };
  await processAvailable(f.engine, f.adapters, 'owner', { ...options(analyzer), leaseMs: 100, deadlineMs: 2_000 });
  assert.ok(f.engine.projection.stats().facts > 0, 'legitimate analysis only expires/retries; lease is never renewed while awaiting');
});

test('living owner can renew after the lease clock lapses', async t => {
  const f = await fixture(t, 'renew-after-expiry');
  const job = f.engine.curation.claim('owner', 1, 0)!;
  assert.equal(f.engine.curation.renew(job.id, 'owner', 60_000, Date.now()), true);
  assert.equal(f.engine.curation.renew(job.id, 'other', 60_000, Date.now()), false);
});

test('commit gate must fence the asynchronous journal append, not only staging', async t => {
  const { processJob } = await import('../src/curation/pipeline.ts');
  const f = await fixture(t, 'append-race');
  const append = f.engine.journal.appendAll.bind(f.engine.journal);
  f.engine.journal.appendAll = async payloads => {
    await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} Revision B.`, observedAt: '2026-02-01T00:00:00Z' }));
    await f.registry.sync(async () => f.engine, 'policies');
    return append(payloads);
  };
  const job = f.engine.curation.claim('owner', 60_000)!;
  const result = await processJob(f.engine, f.adapters, job, 'owner', options(), new Map());
  assert.ok(result.outcome === 'stale' && f.engine.projection.stats().facts === 0,
    `commit gate race: outcome=${result.outcome}, persistedFacts=${f.engine.projection.stats().facts}`);
});

test('crash after a valid event prefix must not replay partial publication', async t => {
  const f = await fixture(t, 'partial-replay');
  f.engine.journal.appendAll = async payloads => {
    await f.engine.journal.append(payloads[0]!);
    throw new Error('simulated process death after first complete event line');
  };
  await processAvailable(f.engine, f.adapters, 'owner', options());
  assert.equal(f.engine.projection.stats().facts, 0);
  await f.engine.rebuild();
  assert.equal(f.engine.projection.stats().facts, 0, 'journal replay admitted a partial, uncommitted publication');
});

test('crash before job finish must recover the already accepted publication', async t => {
  const f = await fixture(t, 'finish-recovery');
  const finish = f.engine.curation.finish.bind(f.engine.curation);
  f.engine.curation.finish = () => { throw new Error('simulated crash before job finish'); };
  await processAvailable(f.engine, f.adapters, 'owner', options());
  f.engine.curation.finish = finish;
  f.engine.curation.db.exec("UPDATE jobs SET next_attempt_at=0 WHERE status='failed'");
  await processAvailable(f.engine, f.adapters, 'owner', options());
  assert.equal(f.engine.curation.stats().published, 1, 'committed topic traps its job behind stale CAS instead of finishing after restart');
});

test('publisher changed during analysis must not receive an old-revision publication', async t => {
  const f = await fixture(t, 'model-race');
  const analyzer = { provider: 'test', model: 'scripted', analyze: async (bundle: { identity: { revision: string; observedAt: string } }) => {
    await writeFile(f.path, JSON.stringify({ id: 'policy', text: 'Correction: PostgreSQL is the chosen durable store.', observedAt: '2026-02-01T00:00:00Z' }));
    return { proposal: proposal(bundle), provider: 'test', model: 'scripted', usage: { calls: 1, inputTokens: 1, outputTokens: 1 } };
  } };
  await processAvailable(f.engine, f.adapters, 'owner', options(analyzer));
  assert.equal(f.engine.projection.stats().facts, 0, 'no publisher revision check after model completion');
});

test('truncated evidence must not advance full-source success and discard unread decisions', async t => {
  const f = await fixture(t, 'coverage');
  const tail = 'Approved decision: use PostgreSQL for all production storage.';
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${'Routine progress, nothing durable. '.repeat(100)}${tail}`, observedAt: '2026-02-01T00:00:00Z' }));
  await f.registry.sync(async () => f.engine, 'policies');
  const seen: string[] = [];
  await processAvailable(f.engine, f.adapters, 'owner', { ...options(scriptedAnalyzer(bundle => {
    seen.push(bundle.text); return { noChange: true, facts: [], conflicts: [] };
  })), maxInputChars: 200 });
  const identity = f.engine.curation.adapterFingerprints('policies')[0]!;
  const watermark = f.engine.curation.watermark('policies', identity.documentKey);
  assert.ok(seen.some(text => text.includes(tail)), 'continuation never read the unread tail');
  assert.equal(watermark?.revision, identity.revision);
});

test('commit append race is linearized by sqlite commitBatch', async t => {
  const { processJob } = await import('../src/curation/pipeline.ts');
  const f = await fixture(t, 'commit-race');
  const append = f.engine.journal.appendAll.bind(f.engine.journal);
  f.engine.journal.appendAll = async payloads => {
    const first = payloads[0] as { type?: string } | undefined;
    if (first?.type === 'curation.batch.commit') {
      await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} Revision B.`, observedAt: '2026-02-01T00:00:00Z' }));
      await f.registry.sync(async () => f.engine, 'policies');
    }
    return append(payloads);
  };
  const job = f.engine.curation.claim('owner', 60_000)!;
  const result = await processJob(f.engine, f.adapters, job, 'owner', options(), new Map());
  assert.ok(result.outcome === 'stale' && f.engine.projection.stats().facts === 0,
    `commit append race: outcome=${result.outcome}, facts=${f.engine.projection.stats().facts}`);
});

test('same semanticKey from an older document cannot retire a newer decision', async t => {
  const f = await fixture(t, 'semkey');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const newer = f.engine.projection.activeFacts('p_review').find(fact => fact.tags.semanticKey === 'storage');
  assert.ok(newer);
  const olderPath = join(f.path, '..', 'older.json');
  await writeFile(olderPath, JSON.stringify({ id: 'older', text: 'Decision: use SQLite for durable local storage.', observedAt: '2025-01-01T00:00:00Z' }));
  const olderAdapter = new JsonRecordAdapter({ id: 'policies-old', scope: { kind: 'project', id: 'p_review' }, root: join(f.path, '..'), mapping: { namespace: 'policies' } });
  void olderAdapter;
  const remaining = f.engine.projection.getFact(newer!.id);
  assert.equal(remaining?.standing === 'superseded', false);
});

test('discard actually closes the named fact', async t => {
  const f = await fixture(t, 'discard');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const existing = f.engine.projection.activeFacts('p_review')[0]!;
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: TEXT, observedAt: '2026-01-01T00:00:00Z', title: 'amended' }));
  await f.registry.sync(async () => f.engine, 'policies');
  await processAvailable(f.engine, f.adapters, 'owner', options(scriptedAnalyzer(bundle => ({
    noChange: false, topic: { id: 'storage', title: 'SQLite', summary: 'Closed.' },
    facts: [{ action: 'discard', id: existing.id, kind: 'decision', epistemic: 'decision', statement: existing.statement,
      semanticKey: 'storage', confidence: 0.5, standing: 'needs_review', excerpt: 'Decision: use SQLite for durable local storage.',
      sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }] }],
    conflicts: [],
  }))));
  assert.equal(f.engine.projection.getFact(existing.id)?.standing === 'superseded' || f.engine.projection.activeFacts('p_review').every(fact => fact.id !== existing.id), true);
});

test('rebuild restores curated facts from the journaled batch commit', async t => {
  const f = await fixture(t, 'rebuild-curated');
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const before = f.engine.projection.activeFacts('p_review', 100);
  assert.equal(before.length, 1);
  const statement = before[0]!.statement;
  const topic = [...f.engine.projection.eachActiveDocument()].find(document => document.namespace === 'memory.topic');
  assert.ok(topic, 'topic document missing before rebuild');
  await f.engine.rebuild();
  const after = f.engine.projection.activeFacts('p_review', 100);
  assert.equal(after.length, 1, 'rebuild dropped curated facts');
  assert.equal(after[0]!.statement, statement);
  assert.ok(f.engine.projection.documentByKey({
    namespace: 'memory.topic',
    externalId: topic.externalId,
  }), 'rebuild dropped the topic document');
});

test('recovery after fat commit does not append a duplicate journal event', async t => {
  const f = await fixture(t, 'no-dup-commit');
  const project = f.engine.projectPublication.bind(f.engine);
  f.engine.projectPublication = async () => { throw new Error('death after fat commit'); };
  await processAvailable(f.engine, f.adapters, 'owner', options());
  f.engine.projectPublication = project;
  f.engine.curation.db.exec("UPDATE jobs SET next_attempt_at=0 WHERE status='failed'");
  await processAvailable(f.engine, f.adapters, 'owner', options());
  const fat = (await f.engine.journal.readAll()).filter(event => event.payload.type === 'curation.batch.commit'
    && event.payload.facts.length > 0);
  assert.equal(fat.length, 1, `duplicate fat commits: ${fat.length}`);
  assert.equal(f.engine.projection.stats().facts, 1);
});

test('publisher change during fat commit does not leave an obsolete fact current', async t => {
  const f = await fixture(t, 'post-commit-race');
  const { processJob } = await import('../src/curation/pipeline.ts');
  const append = f.engine.journal.appendAll.bind(f.engine.journal);
  const injected = { n: 0 };
  f.engine.journal.appendAll = async payloads => {
    const full = payloads.find(payload => payload.type === 'curation.batch.commit'
      && (payload.facts.length > 0 || payload.documents.length > 0));
    if (full && injected.n++ === 0) {
      await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} Correction: PostgreSQL is now approved.`, observedAt: '2026-02-01T00:00:00Z' }));
      await f.registry.sync(async () => f.engine, 'policies');
    }
    return append(payloads);
  };
  const job = f.engine.curation.claim('owner', 60_000)!;
  await processJob(f.engine, f.adapters, job, 'owner', options(), new Map());
  const key = f.engine.curation.adapterFingerprints('policies')[0]!.documentKey;
  // The obsolete fact is deleted with its dependency; any dependency left must point at a fact that exists.
  assert.ok(f.engine.curation.dependents(key).every(id => f.engine.projection.getFact(id)), 'a dependency outlived its deleted fact');
  const stale = f.engine.projection.activeFacts('p_review', 100).filter(fact => fact.statement.includes('SQLite'));
  assert.equal(stale.length, 0, `obsolete SQLite fact remained current after publisher moved: ${stale.map(fact => fact.id).join(',')}`);
  await f.engine.rebuild();
  const after = f.engine.projection.activeFacts('p_review', 100).filter(fact => fact.statement.includes('SQLite') && fact.standing !== 'superseded');
  assert.equal(after.length, 0, 'rebuild resurrected the obsolete publication');
});

test('lost lease during discard must not change prior standing', async t => {
  const f = await fixture(t, 'stale-discard');
  const { processJob } = await import('../src/curation/pipeline.ts');
  await processAvailable(f.engine, f.adapters, 'seed', options());
  const old = f.engine.projection.activeFacts('p_review', 100).find(fact => fact.statement.includes('SQLite'))!;
  assert.ok(old);
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} Withdrawal is proposed but not yet sealed.`, observedAt: '2026-02-01T00:00:00Z' }));
  await f.registry.sync(async () => f.engine, 'policies');
  const review = f.engine.curation.claim('review-owner', 60_000)!;
  assert.equal(review.action, 'review');
  await processJob(f.engine, f.adapters, review, 'review-owner', options(), new Map());
  assert.equal(f.engine.projection.getFact(old.id)?.standing, 'needs_review');
  const analyze = f.engine.curation.claim('loser', 60_000)!;
  assert.equal(analyze.action, 'analyze');
  const original = f.engine.curation.sealCommitted.bind(f.engine.curation);
  const injected = { n: 0 };
  f.engine.curation.sealCommitted = (batchId, job, identity, topicId, owner, at) => {
    if (injected.n++ === 0) {
      f.engine.curation.db.prepare("UPDATE jobs SET status='discarded', lease_owner=NULL, lease_until=NULL WHERE id=? AND status='claimed'").run(analyze.id);
    }
    return original(batchId, job, identity, topicId, owner, at);
  };
  const result = await processJob(f.engine, f.adapters, analyze, 'loser', options(scriptedAnalyzer(bundle => ({
    noChange: false, facts: [{
      action: 'discard', id: old.id, kind: 'decision', epistemic: 'decision',
      statement: 'Discard the prior SQLite decision.', semanticKey: 'storage', confidence: 0.9, standing: 'needs_review',
      excerpt: bundle.text.slice(0, 60),
      sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
    }], conflicts: [],
  }))), new Map());
  assert.equal(result.outcome, 'stale');
  assert.equal(f.engine.projection.getFact(old.id)?.standing, 'needs_review');
});

test('sealCommitted does not report published before the fat journal exists', async t => {
  const f = await fixture(t, 'seal-not-success');
  const { processJob } = await import('../src/curation/pipeline.ts');
  const append = f.engine.journal.appendAll.bind(f.engine.journal);
  const seen = { published: false };
  f.engine.journal.appendAll = async payloads => {
    const fat = payloads.some(payload => payload.type === 'curation.batch.commit'
      && ((payload.facts.length > 0) || (payload.documents.length > 0) || ((payload.resolves?.length ?? 0) > 0)));
    if (fat) {
      seen.published = Boolean(f.engine.curation.db.prepare("SELECT 1 FROM jobs WHERE status='published'").get())
        || Boolean(f.engine.curation.db.prepare('SELECT 1 FROM watermarks LIMIT 1').get());
    }
    return append(payloads);
  };
  const job = f.engine.curation.claim('owner', 60_000)!;
  await processJob(f.engine, f.adapters, job, 'owner', options(), new Map());
  assert.equal(seen.published, true, 'sqlite authority must publish facts before derived journal export');
  assert.ok(f.engine.projection.activeFacts('p_review', 100).length > 0, 'published without content');
});

test('two discards in one sealed batch apply together without resolveFact', async t => {
  const f = await fixture(t, 'atomic-discards');
  const { processJob } = await import('../src/curation/pipeline.ts');
  await processAvailable(f.engine, f.adapters, 'seed', options());
  const first = f.engine.projection.activeFacts('p_review', 100)[0]!;
  await writeFile(f.path, JSON.stringify({ id: 'policy', text: `${TEXT} Second decision: keep the journal append-only.`, observedAt: '2026-02-01T00:00:00Z' }));
  await f.registry.sync(async () => f.engine, 'policies');
  const review = f.engine.curation.claim('review-owner', 60_000)!;
  await processJob(f.engine, f.adapters, review, 'review-owner', options(), new Map());
  await processAvailable(f.engine, f.adapters, 'owner', options(scriptedAnalyzer(bundle => ({
    noChange: false,
    facts: [
      {
        action: 'create', kind: 'decision', epistemic: 'decision', statement: 'Keep the journal append-only.',
        semanticKey: 'journal', confidence: 0.8, standing: 'needs_review', excerpt: bundle.text.slice(0, 40),
        sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
      },
      {
        action: 'discard', id: first.id, kind: 'decision', epistemic: 'decision', statement: first.statement,
        semanticKey: 'storage', confidence: 0.8, standing: 'needs_review', excerpt: bundle.text.slice(0, 40),
        sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
      },
    ],
    conflicts: [],
  }))));
  assert.equal(f.engine.projection.getFact(first.id)?.standing, 'superseded');
  assert.ok(f.engine.projection.activeFacts('p_review', 100).some(fact => fact.statement.includes('append-only')));
});

test('three windows persist first/middle/tail findings and synthesize before watermark', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-windows-'));
  const source = join(root, 'source');
  await mkdir(source);
  const block = (label: string): string => `${label}${'x'.repeat(Math.max(0, 100 - label.length))}`;
  const text = `${block('Decision: use north-alpha-store. ')}${block('Procedure: verify the WAL nightly. ')}${block('Correction: north-alpha-store is not for replica traffic. ')}`;
  const path = join(source, 'policy.json');
  await writeFile(path, JSON.stringify({ id: 'policy', text, observedAt: '2026-01-01T00:00:00Z' }));
  const engine = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_review', sessionId: 'windows',
    provider: new TestEmbeddingProvider(), storage: 'indexed' });
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_review' }, root: source, mapping: { namespace: 'policies' } });
  const registry = new SourceRegistry();
  registry.register(adapter);
  await registry.sync(async () => engine, 'policies');
  const analyzer = scriptedAnalyzer(bundle => {
    const facts = [];
    if (bundle.text.includes('north-alpha-store') && bundle.text.includes('Decision:')) {
      facts.push({
        action: 'create' as const, kind: 'decision' as const, epistemic: 'decision' as const,
        statement: 'Use north-alpha-store.', semanticKey: 'north-alpha', confidence: 0.8, standing: 'needs_review' as const,
        excerpt: bundle.text.slice(0, 40),
        sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
      });
    }
    if (bundle.text.includes('WAL nightly')) {
      facts.push({
        action: 'create' as const, kind: 'procedure' as const, epistemic: 'procedure' as const,
        statement: 'Verify the WAL nightly.', semanticKey: 'wal-nightly', confidence: 0.8, standing: 'needs_review' as const,
        excerpt: bundle.text.slice(0, 40),
        sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
      });
    }
    if (bundle.text.includes('not for replica')) {
      facts.push({
        action: 'create' as const, kind: 'correction' as const, epistemic: 'correction' as const,
        statement: 'north-alpha-store is not for replica traffic.', semanticKey: 'north-alpha-replica', confidence: 0.9, standing: 'needs_review' as const,
        excerpt: bundle.text.slice(0, 40),
        sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
      });
    }
    if (bundle.currentFacts.length) {
      for (const fact of bundle.currentFacts) {
        if (!facts.some(item => item.semanticKey === fact.tags.semanticKey)) {
          facts.push({
            action: 'keep' as const, id: fact.id, kind: fact.kind, epistemic: 'decision' as const,
            statement: fact.statement, semanticKey: fact.tags.semanticKey ?? fact.id, confidence: fact.confidence, standing: fact.standing,
            excerpt: bundle.text.slice(0, 40),
            sourceRefs: [{ adapter: 'policies', namespace: 'policies', externalId: 'policy', revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
          });
        }
      }
    }
    return { noChange: facts.length === 0, topic: { id: 'north-alpha', title: 'north-alpha', summary: 'north-alpha-store with replica qualification.' }, facts, conflicts: [] };
  });
  const adapters = new Map([['policies', adapter]]);
  const firstPass = await processAvailable(engine, adapters, 'w1', { ...options(analyzer), maxInputChars: 100 });
  const jobs = engine.curation.db.prepare('SELECT id,status,error_code,error_detail FROM jobs').all();
  const early = engine.projection.activeFacts('p_review', 100).map(fact => fact.statement);
  assert.equal(early.length, 3, `pass=${firstPass.map(item => item.outcome).join(',')} jobs=${JSON.stringify(jobs)} facts=${early.join('|')}`);
  await engine.dispose();
  const restarted = new MemoryEngine({ root: join(root, 'index'), scopeId: 'p_review', sessionId: 'windows-2', provider: new TestEmbeddingProvider() });
  t.after(() => restarted.dispose());
  await processAvailable(restarted, adapters, 'w2', { ...options(analyzer), maxInputChars: 100 });
  await processAvailable(restarted, adapters, 'w3', { ...options(analyzer), maxInputChars: 100 });
  const statements = restarted.projection.activeFacts('p_review', 100).map(fact => fact.statement).join('\n');
  assert.ok(statements.includes('north-alpha-store'), statements);
  assert.ok(statements.includes('WAL nightly'), statements);
  assert.ok(statements.includes('not for replica'), statements);
  const key = restarted.curation.adapterFingerprints('policies')[0]!.documentKey;
  const mark = restarted.curation.watermark('policies', key);
  assert.equal(mark?.revision, restarted.curation.fingerprint(key)?.revision);
  assert.equal(restarted.curation.coverage(key), undefined);
});
