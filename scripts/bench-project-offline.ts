// Explicit offline diagnostic, never semantic/model acceptance. Reads a caller-selected
// checkout and creates only a new isolated workspace. No source bodies are persisted.
import { readFileSync, statSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { rankOracle, scoreOracle, type OracleCase } from '../src/eval/oracles.ts';
import { TestEmbeddingProvider } from '../tests/helpers.ts';

const arg = (name: string): string => {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new Error(`Required ${name}`);
  return resolve(value);
};
const implementation = arg('--implementation');
const corpus = arg('--corpus');
const workspace = arg('--workspace');
if (existsSync(workspace)) throw new Error('Workspace must not exist.');
mkdirSync(workspace, { recursive: true });
globalThis.fetch = async () => { throw new Error('Network forbidden in offline benchmark.'); };
const { MemoryEngine } = await import(pathToFileURL(join(implementation, 'src/engine.ts')).href);
const { processAvailable } = await import(pathToFileURL(join(implementation, 'src/curation/pipeline.ts')).href);
const { scriptedAnalyzer } = await import(pathToFileURL(join(implementation, 'src/curation/analyzer.ts')).href);
const { SourceRegistry } = await import(pathToFileURL(join(implementation, 'src/sources/registry.ts')).href);
const { federatedSearch } = await import(pathToFileURL(join(implementation, 'src/retrieval/federated.ts')).href);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const bytes = (path: string): number => existsSync(path) ? statSync(path).size : 0;
const treeBytes = (path: string): number => !existsSync(path) ? 0 : readdirSync(path, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? treeBytes(join(path, entry.name)) : bytes(join(path, entry.name))), 0);
const measure = (root: string) => {
  const db = join(root, 'memory.sqlite');
  const parts = { sqlite: bytes(db), wal: bytes(`${db}-wal`), shm: bytes(`${db}-shm`),
    journal: treeBytes(join(root, 'events')) + bytes(`${db}-journal`), checkpoints: treeBytes(join(root, 'checkpoints')) };
  const subtotal = Object.values(parts).reduce((sum, n) => sum + n, 0);
  const other = Math.max(0, treeBytes(root) - subtotal);
  return { ...parts, other, total: subtotal + other };
};
// Seven hand-authored evidence rules. Oracles query six of them; capture-gate is
// ingested but unqueried. Additional source files are substantive real code/docs,
// not repeated padding or manufactured text.
const rules = [
  ['`prjct gauntlet`', 'gauntlet.ship', 'prjct gauntlet runs the project verify commands and records a receipt bound to git HEAD; ship refuses a red receipt.'],
  ['prjct.db', 'storage.sqlite.per-project', 'prjct stores SQLite state as one DB file per project at ~/.prjct-cli/projects/{id}/prjct.db, not as a shared multi-project database.'],
  ['pre-v1.24.1', 'storage.not-dot-prjct', 'Putting all project state in a local .prjct/ directory was the pre-v1.24.1 model and is not current; SQLite is the source of truth.'],
  ['PRJCT_CLI_HOME', 'storage.prjct-cli-home', 'PRJCT_CLI_HOME relocates the entire global store (DB + config + sync metadata).'],
  ['Linear/Jira', 'cli.no-linear-jira', 'prjct no longer exposes native Linear/Jira CLI gateway commands.'],
  ['Living context synthesis', 'living-context.fields', 'Living context synthesis is written by the executing model and captures Context synthesis, Key data, What happened, Why it mattered, Who/author, Model, Token usage, Sentiment, Related files, Feature/domain, Pattern, Anti-pattern, Decision/trap, Outcome, and Next implication.'],
  ['ALWAYS_ACCEPT', 'capture-gate.high-stakes', 'High-stakes types such as decision/learning/fact pass the capture gate when content is not an exact hash duplicate and is not refused as empty, junk, or a precision failure, unless the source is auto-derived.'],
] as const;
const tiny = ['README.md', 'docs/architecture.md', 'docs/storage-and-paths.md', 'core/services/living-context-contract.ts', 'core/services/retention/capture-gate.ts'];
const tracked = execFileSync('git', ['-C', corpus, 'ls-files', '-z']).toString().split('\0')
  .filter(path => /^(?:docs\/.*\.md|core\/.*\.ts|README.md)$/.test(path));
const cases = JSON.parse(readFileSync(new URL('../tests/fixtures/real-project-oracles.json', import.meta.url), 'utf8')) as OracleCase[];
const provider = new TestEmbeddingProvider();
const reports = [];
for (const [name, files] of [['tiny', tiny], ['large', tracked]] as const) {
  const root = join(workspace, name);
  const source = files.map(path => ({ path, text: readFileSync(join(corpus, path), 'utf8') }));
  const rawBytes = source.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
  const open = () => new MemoryEngine({ root, scopeId: 'p_benchmark', sessionId: 'offline', provider });
  const samplerOutput = join(workspace, `.storage-samples-${name}.json`);
  const sampler = spawn(process.execPath, [fileURLToPath(new URL('./storage-sampler.mjs', import.meta.url)), root, samplerOutput],
    { stdio: 'ignore' });
  const waitForSampler = async (remaining = 100): Promise<void> => {
    if (existsSync(samplerOutput)) return;
    if (remaining <= 0 || sampler.exitCode !== null) throw new Error('Independent storage sampler did not start.');
    await sleep(10);
    await waitForSampler(remaining - 1);
  };
  await waitForSampler();
  const engine = open();
  const fixedOverhead = measure(root);
  const adapter = { id: 'real-docs', scope: { kind: 'project', id: 'p_benchmark' }, scan: async () => source.map(file => ({
    namespace: 'project.docs', externalId: file.path, scopeId: 'p_benchmark', scopeKind: 'project', source: 'real-docs', kind: 'document',
    title: file.path, text: file.text, uri: join(corpus, file.path), version: hash(file.text), contentHash: hash(file.text),
    observedAt: '2026-09-01T00:00:00.000Z', trust: 'imported', metadata: { path: file.path },
  })) };
  const registry = new SourceRegistry(); registry.register(adapter);
  const syncStarted = performance.now();
  await registry.sync(async () => engine, adapter.id);
  const syncMs = performance.now() - syncStarted;
  const curationStarted = performance.now();
  await processAvailable(engine, new Map([[adapter.id, adapter]]), 'offline', {
    analyzer: scriptedAnalyzer((bundle: any) => {
      const facts = rules.flatMap(([needle, semanticKey, statement]) => {
        const index = bundle.text.indexOf(needle);
        if (index < 0) return [];
        return [{ action: 'create', confidence: 0.82, standing: 'supported', kind: 'constraint', epistemic: 'constraint', semanticKey, statement,
          excerpt: bundle.text.slice(index, index + Math.max(needle.length, 120)).slice(0, 500),
          sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace, externalId: bundle.identity.externalId,
            revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }] }];
      });
      return { noChange: facts.length === 0, topic: { id: bundle.identity.externalId.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 48),
        title: bundle.identity.title, summary: facts.map((fact: any) => fact.statement).join(' ') || 'No durable facts in this window.' }, facts, conflicts: [] };
    }), maxAttempts: 5, maxInputChars: 8_000, budget: { maxCallsPerDay: 100_000, maxTokensPerDay: 100_000_000 },
  });
  const curationMs = performance.now() - curationStarted;
  const live = measure(root);
  if (engine.projection.checkpointWal) engine.projection.checkpointWal();
  else {
    // Baseline has no policy. The benchmark explicitly measures the same clean
    // maintenance state without pretending this happened automatically in r16.
    engine.projection.db.exec('PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA busy_timeout=5000');
  }
  const cleanQuiescent = measure(root);
  const diagnostics = [];
  for (const kase of cases) {
    for (const route of ['lookup', 'automatic', 'lookup-default', 'automatic-default'] as const) {
      const request = { queries: [kase.query], dense: route.endsWith('-default'), limit: 6, maxBytes: 4096, namespaces: ['memory', 'memory.topic'] };
      const search = () => route.startsWith('lookup') ? engine.search(request) : federatedSearch([engine], request);
      const start = performance.now();
      const result = await search();
      const coldMs = performance.now() - start;
      const warmMs = [];
      for (const _ of [1, 2, 3, 4, 5]) { const begin = performance.now(); await search(); warmMs.push(performance.now() - begin); }
      const score = scoreOracle(result.items, kase, result);
      const ranking = rankOracle(result.items, kase, 10);
      diagnostics.push({ ...score, ...ranking, route, coldMs, warmMs,
        supportedItems: result.items.filter((item: any) => kase.expectedStatements.length > 0 && kase.expectedStatements.every(text => item.statement.toLowerCase().includes(text.toLowerCase()))).length,
        items: result.items.length,
        statements: result.items.map((item: any) => item.statement), gaps: result.gaps });
    }
  }
  const facts = engine.projection.stats().facts;
  await engine.dispose();
  const closed = measure(root);
  const reopened = open(); const postReopen = measure(root); await reopened.dispose();
  sampler.kill('SIGTERM');
  await once(sampler, 'exit');
  const sampled = JSON.parse(readFileSync(samplerOutput, 'utf8')) as {
    peakTotalSnapshot: ReturnType<typeof measure>; peakWalSnapshot: ReturnType<typeof measure>;
  };
  const negatives = diagnostics.filter(row => row.kind === 'unanswerable');
  const positives = diagnostics.filter(row => row.kind !== 'unanswerable');
  const timings = diagnostics.flatMap(row => row.warmMs).sort((a, b) => a - b);
  reports.push({ name, sourceFiles: files.length, rawBytes, sourceDigest: hash(source.map(file => `${file.path}:${hash(file.text)}`).join('\n')),
    facts, ingestMs: { sync: syncMs, curation: curationMs, total: syncMs + curationMs },
    fixedOverhead, peakLive: sampled.peakTotalSnapshot, peakWal: sampled.peakWalSnapshot.wal,
    peakWalSnapshot: sampled.peakWalSnapshot, live, cleanQuiescent, closed, postReopen,
    storage: cleanQuiescent.total < rawBytes ? 'WIN' : 'NOT A WIN', breakEvenBytes: cleanQuiescent.total,
    falsePositives: negatives.filter(row => row.items > 0).length, negativeCases: negatives.length,
    negativeAbstentionRate: negatives.filter(row => row.passed).length / negatives.length,
    diagnosticCandidatePrecision: positives.reduce((sum, row) => sum + row.supportedItems, 0) / Math.max(1, positives.reduce((sum, row) => sum + row.items, 0)),
    diagnosticRecall: positives.filter(row => row.passed).length / positives.length,
    diagnosticMrr: positives.reduce((sum, row) => sum + row.reciprocalRank, 0) / positives.length,
    diagnosticNdcgAt10: positives.reduce((sum, row) => sum + row.ndcgAtK, 0) / positives.length,
    latency: { firstQueryMs: diagnostics[0]?.coldMs, warmP50Ms: timings[Math.floor(timings.length * 0.5)], warmP95Ms: timings[Math.floor(timings.length * 0.95)] }, diagnostics });
}
const report = { implementation, corpus, pin: execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD']).toString().trim(),
  semantic: 'SUBSTRING DIAGNOSTICS ONLY — seven ingested rules, six queried; capture-gate untested; synthesis and out-of-fixture quality unreviewed', reports };
writeFileSync(join(workspace, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(reports.map(({ diagnostics, ...report }) => ({ ...report, oracleFailures: diagnostics.filter(row => !row.passed).map(row => `${row.name}/${row.route}`) })), null, 2));
