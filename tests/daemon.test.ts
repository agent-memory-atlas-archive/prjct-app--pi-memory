import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedAnalyzer } from '../src/curation/analyzer.ts';
import { loadDaemonConfig } from '../src/daemon/config.ts';
import { GlobalBudgetLedger } from '../src/daemon/budget.ts';
import { executeDaemonCommand } from '../src/daemon/cli.ts';
import { daemonStatus, startDaemon, stopDaemon } from '../src/daemon/lifecycle.ts';
import { discoverProjectIds, runCycle } from '../src/daemon/worker.ts';
import { MemoryEngine } from '../src/engine.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { appendSessionObservations } from '../src/sources/session-log.ts';
import { TestEmbeddingProvider } from './helpers.ts';

test('daemon discovery includes standalone registry bindings without a legacy identity index', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-daemon-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  const initialized = await MemoryEngine.initializeProject(checkout, 'daemon-discovery', {
    home, provider: new TestEmbeddingProvider(),
  });
  await initialized.engine.dispose();
  assert.deepEqual(await discoverProjectIds(home), [initialized.binding.projectId]);
});

test('the shared budget permits only one claimant for the last call', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-budget-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = new GlobalBudgetLedger(home);
  const second = new GlobalBudgetLedger(home);
  t.after(() => { first.close(); second.close(); });
  const limits = { maxCallsPerDay: 1, maxTokensPerDay: 100 };
  const claims = [first, second].map(ledger => ledger.reserve(limits, { inputTokens: 10, outputTokens: 10 }));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(first.usage().calls, 1);
});

test('once/start/stop/status are explicit and Pi-closed cycles publish curated knowledge', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-daemon-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const idle = await executeDaemonCommand(['status', '--home', home]);
  assert.equal((idle as { running: boolean }).running, false);

  const source = join(home, 'source');
  await mkdir(source);
  await writeFile(join(source, 'policy.json'), JSON.stringify({
    id: 'storage-policy', text: 'Decision: keep memory analysis running while Pi is closed.',
    observedAt: '2026-01-01T00:00:00.000Z',
  }));
  const engine = new MemoryEngine({ root: join(home, 'p_test', 'memory'), scopeId: 'p_test', sessionId: 'daemon-test',
    provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const registry = new SourceRegistry();
  registry.register(new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies' } }));
  await registry.sync(async () => engine, 'policies');
  const config = await loadDaemonConfig({ home, intervalMs: 60_000, maxAttempts: 3, maxCallsPerDay: 20, maxTokensPerDay: 20_000 });
  const calls = { n: 0 };
  const extra = [new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_test' }, root: source,
    mapping: { namespace: 'policies' } })];
  const report = await runCycle({
    config, owner: 'daemon-test', engines: [engine], extraAdapters: extra,
    analyzer: scriptedAnalyzer(bundle => {
      calls.n += 1;
      return {
        noChange: false,
        topic: { id: 'daemon', title: 'Daemon', summary: 'Analysis continues with Pi closed.' },
        facts: [{
          action: 'create', kind: 'decision', epistemic: 'decision',
          statement: 'The memory daemon analyzes sources while Pi is closed.', confidence: 0.8, standing: 'needs_review',
          semanticKey: 'daemon.closed', excerpt: 'Decision: keep memory analysis running while Pi is closed.',
          sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace, externalId: bundle.identity.externalId,
            revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
        }],
        conflicts: [],
      };
    }),
  });
  assert.equal(report.modelCalls, 1);
  assert.equal(calls.n, 1);
  assert.ok(engine.projection.activeFacts('p_test').some(fact => fact.statement.includes('Pi is closed')));
  const idleCycle = await runCycle({
    config, owner: 'daemon-test', engines: [engine], extraAdapters: extra,
    analyzer: scriptedAnalyzer(bundle => {
      calls.n += 1;
      return { noChange: true, facts: [], conflicts: [] };
    }),
  });
  assert.equal(idleCycle.modelCalls, 0);
  assert.equal(calls.n, 1);

  const started = await startDaemon({ ...config, intervalMs: 30_000 });
  t.after(() => stopDaemon(home));
  assert.equal((await daemonStatus(home)).running, true);
  assert.equal((await daemonStatus(home)).pid, started.pid);
  const stopped = await stopDaemon(home);
  assert.equal(stopped.stopped, true);
  assert.equal((await daemonStatus(home)).running, false);
});

test('a daemon cycle curates pi-session corrections once, advances its watermark, and cannot republish secrets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-session-daemon-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const secret = 'super-secret-value';
  const records = [
    { id: 'ignored-1', kind: 'correction' as const, tool: 'user_input', outcome: 'stated' as const,
      summary: 'Never use npm in this repository; use pnpm instead.', observedAt: '2026-01-01T00:00:00.000Z',
      provenance: 'declared' as const, sessionId: 's1' },
    { id: 'ignored-2', kind: 'correction' as const, tool: 'user_input', outcome: 'stated' as const,
      summary: `Never paste API_TOKEN=${secret}; use vault references instead.`, observedAt: '2026-01-01T00:01:00.000Z',
      provenance: 'declared' as const, sessionId: 's1' },
  ];
  await appendSessionObservations({ projectId: 'p_session', home, records });
  const engine = await MemoryEngine.forScope('project', 'p_session', 'daemon-session', {
    home, provider: new TestEmbeddingProvider(),
  });
  t.after(() => engine.dispose());
  const config = await loadDaemonConfig({ home, maxCallsPerDay: 20, maxTokensPerDay: 20_000 });
  const seen: string[] = [];
  const analyzer = scriptedAnalyzer(bundle => {
    seen.push(bundle.text);
    return {
      noChange: false,
      topic: { id: bundle.identity.externalId, title: 'Session correction', summary: bundle.text },
      facts: [{ action: 'create', kind: 'correction', epistemic: 'correction', statement: bundle.text,
        confidence: 1, standing: 'supported', semanticKey: bundle.identity.metadata.semanticKey ?? bundle.identity.externalId,
        excerpt: bundle.text, sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace,
          externalId: bundle.identity.externalId, revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }] }],
      conflicts: [],
    };
  });
  const first = await runCycle({ config, owner: 'session-daemon', engines: [engine], analyzer });
  assert.equal(first.modelCalls, 2);
  assert.ok(engine.projection.activeFacts(engine.scopeId).every(fact => fact.standing === 'supported'));
  assert.ok(engine.projection.activeFacts(engine.scopeId).every(fact => fact.evidence[0]?.provenance === 'declared'));
  assert.ok(seen.every(text => !text.includes(secret)));
  assert.doesNotMatch(JSON.stringify(engine.projection.activeFacts(engine.scopeId)), new RegExp(secret));
  const marks = engine.curation.adapterFingerprints('pi-session').map(identity => engine.curation.watermark('pi-session', identity.documentKey));
  assert.ok(marks.every(mark => mark?.outcome === 'published'));
  const second = await runCycle({ config, owner: 'session-daemon', engines: [engine], analyzer });
  assert.equal(second.modelCalls, 0);
});

test('an auto-derived tool failure cannot be published as a decision', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-session-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await appendSessionObservations({ projectId: 'p_gate', home, records: [{
    id: 'ignored', kind: 'failure', tool: 'bash', outcome: 'failed',
    summary: 'bash failed because the cache key omitted inode and size, leaving stale generated output',
    observedAt: '2026-01-01T00:00:00.000Z', provenance: 'native_observation', sessionId: 's1',
  }] });
  const engine = await MemoryEngine.forScope('project', 'p_gate', 'daemon-gate', { home, provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const config = await loadDaemonConfig({ home, maxCallsPerDay: 10, maxTokensPerDay: 10_000 });
  await runCycle({ config, owner: 'gate-daemon', engines: [engine], analyzer: scriptedAnalyzer(bundle => ({
    noChange: false, topic: { id: 'bad', title: 'Bad promotion', summary: 'Treat a one-off failure as policy.' },
    facts: [{ action: 'create', kind: 'decision', epistemic: 'decision', statement: 'Missing scripts are a product decision.',
      confidence: 1, standing: 'supported', semanticKey: 'bad.decision', excerpt: bundle.text,
      sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace,
        externalId: bundle.identity.externalId, revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }] }],
    conflicts: [],
  })) });
  assert.equal(engine.projection.activeFacts(engine.scopeId).length, 0);
  assert.equal([...engine.projection.eachActiveDocument()].filter(document => document.namespace === 'memory.topic').length, 0);
});
