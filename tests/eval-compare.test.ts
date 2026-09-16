import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedAnalyzer } from '../src/curation/analyzer.ts';
import { processJob } from '../src/curation/pipeline.ts';
import { MemoryEngine } from '../src/engine.ts';
import { runCompareCli } from '../src/eval/cli.ts';
import { assertCases, assertCompareConfig, diagnose, runComparison } from '../src/eval/comparison.ts';
import { packEvidence } from '../src/eval/evidence.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const baseConfig = {
  projectId: 'p_eval',
  analysis: { provider: 'test', model: 'scripted' },
  answer: { provider: 'test', model: 'answer-v1' },
  budget: { maxCallsPerDay: 20, maxTokensPerDay: 10_000 },
};

test('compare config rejects missing providers, budget, maxUsd and empty cases', () => {
  assert.throws(() => assertCompareConfig({ workspace: '/tmp', projectId: 'p_x' }), /analysis.provider/);
  assert.throws(() => assertCompareConfig({
    workspace: '/tmp', ...baseConfig, budget: { maxCallsPerDay: 1, maxTokensPerDay: 10, maxUsd: 1 },
  }), /maxUsd/);
  assert.throws(() => assertCases([]), /empty/);
});

test('diagnostics flag negated required text and citations missing from the answer', () => {
  const diagnosed = diagnose('Use SQLite locally.', {
    name: 'storage', query: 'store', required: ['not SQLite'], citations: ['Decision: use SQLite'],
  }, 'curated-memory');
  assert.deepEqual(diagnosed.missingRequired, ['not SQLite']);
  assert.deepEqual(diagnosed.missingCitations, ['Decision: use SQLite']);
});

test('comparison runner counts thrown calls and never auto-PASSes', async () => {
  const calls: string[] = [];
  const report = await runComparison({
    config: { workspace: '/tmp', ...baseConfig },
    cases: [{ name: 'alpha', query: 'Where is alpha?', required: ['alpha-store'] }],
    pack: () => ({
      evidenceComplete: 'Keep alpha-store.', previousDocument: 'raw source body', curatedMemory: 'curated alpha-store', priorFacts: ['prior'],
    }),
    answer: {
      provider: 'test', model: 'answer-v1',
      answer: async request => {
        calls.push(`${request.condition}:${request.evidence.slice(0, 12)}`);
        if (request.condition === 'previous-document') throw new Error('provider down');
        return { text: 'Keep alpha-store. Decision: use SQLite', inputTokens: 8, outputTokens: 4 };
      },
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[0]?.startsWith('evidence-complete:'));
  assert.ok(calls[1]?.startsWith('previous-document:'));
  assert.ok(calls[2]?.startsWith('curated-memory:'));
  assert.equal(report.spend.failedCalls, 1);
  assert.equal(report.status, 'unreviewed');
  assert.equal(report.passed, false);
});

test('CLI real branch accepts injected adapters on an empty workspace', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'cmp-cli-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const configPath = join(workspace, 'cfg.json');
  const casesPath = join(workspace, 'cases.json');
  await writeFile(configPath, JSON.stringify({ projectId: 'p_eval', analysis: baseConfig.analysis, answer: baseConfig.answer, budget: baseConfig.budget }));
  await writeFile(casesPath, JSON.stringify([{ name: 'q', query: 'alpha', required: ['alpha'] }]));
  const empty = await mkdtemp(join(tmpdir(), 'cmp-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const dry = await runCompareCli(['--config', configPath, '--cases', casesPath, '--workspace', empty, '--dry-run']);
  assert.equal(dry.status, 'unreviewed');
  assert.match(dry.reason ?? '', /Dry-run/);
  const empty2 = await mkdtemp(join(tmpdir(), 'cmp-empty2-'));
  t.after(() => rm(empty2, { recursive: true, force: true }));
  const live = await runCompareCli(['--config', configPath, '--cases', casesPath, '--workspace', empty2], {
    answer: { provider: 'test', model: 'answer-v1', answer: async () => ({ text: 'alpha', inputTokens: 1, outputTokens: 1 }) },
    pack: () => ({ evidenceComplete: 'alpha', previousDocument: 'doc', curatedMemory: 'mem', priorFacts: [] }),
  });
  assert.equal(live.cases.length, 3);
  assert.equal(live.passed, false);
  assert.equal(live.status, 'unreviewed');
});

test('ISO-11 first truncated window advances coverage and does not watermark', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iso11-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'source');
  await mkdir(source);
  const segments = ['Alpha segment decision one.', 'Beta segment decision two.', 'Gamma segment decision three.'];
  await writeFile(join(source, 'policy.json'), JSON.stringify({ id: 'iso11', text: segments.join(' '), observedAt: '2026-01-01T00:00:00.000Z' }));
  const engine = await MemoryEngine.forScope('project', 'p_iso11par', 's1', { home, provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const adapter = new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_iso11par' }, root: source, mapping: { namespace: 'policies' } });
  const registry = new SourceRegistry();
  registry.register(adapter);
  await registry.sync(async () => engine, 'policies');
  const docKey = engine.curation.adapterFingerprints('policies')[0]!.documentKey;
  const analyzer = scriptedAnalyzer(bundle => {
    const word = bundle.text.trim().split(/\s+/)[0]!.replace(/[^A-Za-z]/g, '') || 'Window';
    return {
      noChange: false,
      topic: { id: 'cov', title: 'Coverage', summary: 'Windowed coverage topic.' },
      facts: [{ action: 'create', kind: 'decision', epistemic: 'decision', statement: `Fact from segment ${word}`,
        confidence: 0.8, standing: 'needs_review', semanticKey: `cov.${word.toLowerCase()}`, excerpt: word, sourceRefs: [] }],
      conflicts: [],
    };
  });
  const maxInputChars = Math.floor(segments.join(' ').length / 3);
  const job = engine.curation.claim('owner-partial', 60_000, Date.now());
  assert.ok(job);
  await processJob(engine, new Map([['policies', adapter]]), job, 'owner-partial', {
    analyzer, maxAttempts: 5, maxInputChars, budget: { maxCallsPerDay: 50, maxTokensPerDay: 100_000 },
  });
  assert.equal(engine.curation.watermark('policies', docKey), undefined);
  const coverage = engine.curation.coverage(docKey);
  assert.ok(coverage && coverage.offset > 0 && coverage.offset < coverage.total, JSON.stringify(coverage));
  const packed = await packEvidence(engine, 'Alpha');
  assert.notEqual(packed.evidenceComplete, packed.previousDocument);
});

test('ISO-11 drained continuation yields three sentence-aligned facts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iso11full-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'source');
  await mkdir(source);
  const segments = ['Alpha segment decision one.', 'Beta segment decision two.', 'Gamma segment decision three.'];
  await writeFile(join(source, 'policy.json'), JSON.stringify({ id: 'iso11', text: segments.join(' '), observedAt: '2026-01-01T00:00:00.000Z' }));
  const engine = await MemoryEngine.forScope('project', 'p_iso11cov', 's1', { home, provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const adapter = new JsonRecordAdapter({ id: 'policies', scope: { kind: 'project', id: 'p_iso11cov' }, root: source, mapping: { namespace: 'policies' } });
  new SourceRegistry().register(adapter);
  await adapter.scan().then(async () => {
    const registry = new SourceRegistry();
    registry.register(adapter);
    await registry.sync(async () => engine, 'policies');
  });
  const living: unknown[] = [];
  const analyzer = scriptedAnalyzer(bundle => {
    if (bundle.livingContext) living.push(bundle.livingContext);
    const word = bundle.text.trim().split(/\s+/)[0]!.replace(/[^A-Za-z]/g, '') || 'Window';
    return {
      noChange: false,
      topic: { id: 'cov', title: 'Coverage', summary: 'Windowed coverage topic.' },
      facts: [{ action: 'create', kind: 'decision', epistemic: 'decision', statement: `Fact from segment ${word}`,
        confidence: 0.8, standing: 'needs_review', semanticKey: `cov.${word.toLowerCase()}`, excerpt: word, sourceRefs: [] }],
      conflicts: [],
    };
  });
  const { processAvailable } = await import('../src/curation/pipeline.ts');
  const maxInputChars = Math.floor(segments.join(' ').length / 3);
  await processAvailable(engine, new Map([['policies', adapter]]), 'owner-cov', {
    analyzer, maxAttempts: 5, maxInputChars, budget: { maxCallsPerDay: 50, maxTokensPerDay: 100_000 },
  });
  const facts = engine.projection.activeFacts('p_iso11cov', 100).filter(fact => fact.tags.semanticKey?.startsWith('cov.') && fact.standing !== 'superseded');
  assert.deepEqual(facts.map(fact => fact.statement).sort(), [
    'Fact from segment Alpha', 'Fact from segment Beta', 'Fact from segment Gamma',
  ].sort());
  const docKey = engine.curation.adapterFingerprints('policies')[0]!.documentKey;
  assert.equal(engine.curation.watermark('policies', docKey)?.outcome, 'published');
  assert.equal(living.length, 1, 'the final window must run one real bounded synthesis');
  assert.deepEqual(Object.keys(living[0] as Record<string, unknown>).sort(),
    ['blocked', 'constraints', 'decisions', 'done', 'evidenceRefs', 'goal', 'inProgress', 'nextSteps'].sort());
});
