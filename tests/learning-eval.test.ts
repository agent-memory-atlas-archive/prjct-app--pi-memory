import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedAnalyzer } from '../src/curation/analyzer.ts';
import { loadDaemonConfig } from '../src/daemon/config.ts';
import { runCycle } from '../src/daemon/worker.ts';
import { MemoryEngine } from '../src/engine.ts';
import { appendSessionObservations } from '../src/sources/session-log.ts';
import { TestEmbeddingProvider } from './helpers.ts';

type LearningCase = Readonly<{ name: string; correction: string; query: string; expected: string }>;
type OracleCase = Readonly<{ name: string; query: string; kind: string }>;

test('four session corrections become supported facts and are recalled after a daemon-only handoff', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-learning-eval-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cases = JSON.parse(await readFile(new URL('./fixtures/session-learning.json', import.meta.url), 'utf8')) as LearningCase[];
  await appendSessionObservations({ projectId: 'p_learning', home, records: cases.map((kase, index) => ({
    id: `ignored-${index}`, kind: 'correction', tool: 'user_input', outcome: 'stated', summary: kase.correction,
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), provenance: 'declared', sessionId: 'source-session',
  })) });
  const first = await MemoryEngine.forScope('project', 'p_learning', 'daemon', { home, provider: new TestEmbeddingProvider() });
  const config = await loadDaemonConfig({ home, maxCallsPerDay: 20, maxTokensPerDay: 50_000 });
  const analyzer = scriptedAnalyzer(bundle => ({
    noChange: false,
    topic: { id: bundle.identity.externalId, title: 'Declared correction', summary: bundle.text },
    facts: [{ action: 'create', kind: 'correction', epistemic: 'correction', statement: bundle.text,
      confidence: 1, standing: 'supported', semanticKey: bundle.identity.metadata.semanticKey ?? bundle.identity.externalId,
      excerpt: bundle.text, sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace,
        externalId: bundle.identity.externalId, revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }] }],
    conflicts: [],
  }));
  const report = await runCycle({ config, owner: 'learning-daemon', engines: [first], analyzer });
  assert.equal(report.modelCalls, cases.length);
  await first.dispose();

  const nextSession = await MemoryEngine.forScope('project', 'p_learning', 'new-session', {
    home, provider: new TestEmbeddingProvider(),
  });
  t.after(() => nextSession.dispose());
  for (const kase of cases) {
    const recalled = await nextSession.search({ queries: [kase.query], dense: false, namespaces: ['memory', 'memory.topic'] });
    assert.ok(recalled.items.some(item => item.statement.toLocaleLowerCase().includes(kase.expected.toLocaleLowerCase())),
      `${kase.name}: ${JSON.stringify(recalled)}`);
    assert.ok(recalled.items.filter(item => item.namespace === 'memory').every(item => item.standing === 'supported'));
  }

  const oracles = JSON.parse(await readFile(new URL('./fixtures/real-project-oracles.json', import.meta.url), 'utf8')) as OracleCase[];
  for (const kase of oracles.filter(item => /^N[1-4]$/u.test(item.name))) {
    const abstained = await nextSession.search({ queries: [kase.query], dense: false, namespaces: ['memory', 'memory.topic'] });
    assert.equal(abstained.status, 'abstained', kase.name);
    assert.equal(abstained.items.length, 0, kase.name);
  }
});
