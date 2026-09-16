import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile, lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { scriptedAnalyzer, tryCreateSdkAnalyzer } from '../src/curation/analyzer.ts';
import { isCuratedNamespace } from '../src/curation/types.ts';
import { loadDaemonConfig } from '../src/daemon/config.ts';
import { runCycle } from '../src/daemon/worker.ts';
import { MemoryEngine } from '../src/engine.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { prjctHomeFor } from '../src/workspace/project-identity.ts';

type Case = { name: string; projectId: string; query: string; contains?: string; citation?: string; abstain?: boolean };
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const casesPath = arg('--cases');
if (!casesPath) throw new Error('Usage: npm run eval:curated -- --cases /private/cases.json [--workspace /private/new-copy]');
const cases: Case[] = JSON.parse(await readFile(resolve(casesPath), 'utf8'));
const specified = arg('--workspace');
const workspace = specified ? resolve(specified) : await mkdtemp(join(tmpdir(), 'pi-memory-curated-'));
await mkdir(workspace, { recursive: true, mode: 0o700 });
const existing = await readdir(workspace);
if (process.argv.includes('--reuse')) {
  if (!existing.includes('snapshot.json')) throw new Error('Cannot --reuse a workspace without snapshot.json.');
} else if (existing.length) {
  throw new Error('Workspace is not empty. Pass --reuse or a new empty directory (mktemp -d is empty and valid).');
}
const copy = async (source: string, destination: string): Promise<void> => {
  await cp(source, destination, { recursive: true, filter: async path => {
    if ((await lstat(path)).isSymbolicLink()) return false;
    return !relative(source, path).split('/').some(part => ['memory', 'vector', 'backups'].includes(part));
  } });
};
const sourceHome = join(workspace, 'source');
const indexes = join(workspace, 'indexes');
const models = join(workspace, 'models');
if (!process.argv.includes('--reuse')) {
  const source = resolve(arg('--home') ?? prjctHomeFor());
  await mkdir(sourceHome, { mode: 0o700 });
  for (const projectId of [...new Set(cases.map(item => item.projectId))]) {
    await copy(join(source, projectId), join(sourceHome, projectId));
  }
  await mkdir(indexes, { mode: 0o700 });
  await mkdir(models, { mode: 0o700 });
  await writeFile(join(workspace, 'snapshot.json'), JSON.stringify({ source: sourceHome, indexes, models }, null, 2));
}
const canonical = await realpath(workspace);
for (const path of [sourceHome, indexes]) {
  if (!(await stat(path).catch(() => undefined))) throw new Error(`Missing workspace path ${path}`);
  const rel = relative(canonical, await realpath(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Curated eval paths must stay inside the workspace.');
}
process.env.PRJCT_HOME = indexes;
const config = await loadDaemonConfig({
  home: indexes, intervalMs: 1_000, maxAttempts: 3, maxCallsPerDay: 10_000, maxTokensPerDay: 2_000_000,
  ...(process.env.PI_MEMORY_ANALYSIS_PROVIDER ? { provider: process.env.PI_MEMORY_ANALYSIS_PROVIDER } : {}),
  ...(process.env.PI_MEMORY_ANALYSIS_MODEL ? { model: process.env.PI_MEMORY_ANALYSIS_MODEL } : {}),
});
const resolved = await tryCreateSdkAnalyzer({
  ...(config.provider ? { provider: config.provider } : {}),
  ...(config.model ? { model: config.model } : {}),
  maxOutputChars: config.maxOutputChars,
});
const fallback = scriptedAnalyzer(bundle => {
  const statement = bundle.text.split('\n').find(line => /decision|constraint|correction|procedure/i.test(line)) ?? bundle.text.slice(0, 240);
  const excerpt = bundle.text.slice(0, Math.min(180, bundle.text.length));
  return {
    noChange: false,
    topic: { id: 'topic', title: bundle.identity.title ?? bundle.identity.kind, summary: statement.slice(0, 400) },
    facts: [{
      action: 'create', kind: 'decision', epistemic: 'decision', statement: statement.slice(0, 800), confidence: 0.6,
      standing: 'needs_review', semanticKey: bundle.identity.documentKey.slice(0, 64),
      sourceRefs: [{ adapter: bundle.identity.adapter, namespace: bundle.identity.namespace, externalId: bundle.identity.externalId,
        revision: bundle.identity.revision, observedAt: bundle.identity.observedAt }],
      excerpt,
    }],
    conflicts: [],
  };
});
const mock = process.argv.includes('--mock');
const analyzer = resolved.analyzer ?? (mock ? fallback : undefined);
if (!analyzer) {
  throw new Error(resolved.block?.message ?? 'Configured PI_MEMORY_ANALYSIS_PROVIDER/MODEL is required. Pass --mock for the scripted analyzer.');
}
const engines: MemoryEngine[] = [];
for (const id of [...new Set(cases.map(item => item.projectId))]) {
  engines.push(await MemoryEngine.forScope('project', id, 'curated-eval', { home: indexes }));
}
const started = Date.now();
const cycle = await runCycle({ config: { ...config, home: sourceHome }, owner: 'curated-eval', analyzer, engines });
const rawBodies: string[] = [];
for (const engine of engines) {
  for (const event of await engine.journal.readAll()) {
    if (event.payload.type === 'document.upserted' && !isCuratedNamespace(event.payload.document.namespace)) {
      rawBodies.push(`${engine.scopeId}:${event.payload.document.namespace}:${event.payload.document.externalId}`);
    }
  }
}
const results = [];
for (const item of cases) {
  const project = engines.find(engine => engine.scopeKind === 'project' && engine.scopeId === item.projectId);
  if (!project) throw new Error(`No engine for ${item.projectId}`);
  const scoped = [project];
  const found = await federatedSearch(scoped, {
    queries: [item.query], dense: false, limit: 6, maxBytes: 12_000, namespaces: ['memory', 'memory.topic'],
  });
  const hit = found.items.find(candidate => {
    if (item.contains && !candidate.statement.toLowerCase().includes(item.contains.toLowerCase())) return false;
    if (!item.citation) return true;
    const owner = scoped.find(engine => engine.projection.getFact(candidate.id));
    const excerpts = owner?.projection.getFact(candidate.id)?.evidence.map(entry => entry.excerpt).join('\n') ?? '';
    return excerpts.toLowerCase().includes(item.citation.toLowerCase());
  });
  const passed = item.abstain ? found.status === 'abstained' : Boolean(hit);
  results.push({ name: item.name, passed, status: found.status, id: hit?.id, namespace: hit?.namespace, standing: hit?.standing });
}
const report = {
  semantic: resolved.analyzer ? 'sdk' : 'mock',
  note: resolved.analyzer
    ? 'Used the configured ModelRuntime analyzer.'
    : 'This run used a scripted analyzer. Do not claim real semantic/model validation.',
  elapsedMs: Date.now() - started, cycle,
  vectors: engines.reduce((sum, engine) => sum + engine.projection.stats().vectors, 0),
  facts: engines.reduce((sum, engine) => sum + engine.projection.stats().facts, 0),
  bytes: engines.reduce((sum, engine) => sum + engine.projection.stats().bytes, 0),
  tokens: cycle.inputTokens + cycle.outputTokens,
  modelCalls: cycle.modelCalls,
  rawBodiesInNewEvents: rawBodies,
  results, passed: results.every(result => result.passed) && rawBodies.length === 0,
};
await writeFile(join(workspace, 'curated-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ workspace, report: join(workspace, 'curated-report.json'), ...report }, null, 2));
if (!report.passed) process.exitCode = 1;
for (const engine of engines) await engine.dispose();
