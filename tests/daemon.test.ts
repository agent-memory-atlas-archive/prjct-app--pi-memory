import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedAnalyzer } from '../src/curation/analyzer.ts';
import { loadDaemonConfig } from '../src/daemon/config.ts';
import { executeDaemonCommand } from '../src/daemon/cli.ts';
import { daemonStatus, startDaemon, stopDaemon } from '../src/daemon/lifecycle.ts';
import { runCycle } from '../src/daemon/worker.ts';
import { MemoryEngine } from '../src/engine.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { TestEmbeddingProvider } from './helpers.ts';

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
