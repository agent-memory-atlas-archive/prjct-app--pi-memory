import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { documentKey } from '../src/contracts/documents.ts';
import { MemoryEngine } from '../src/engine.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { DEFAULT_RECALL_THRESHOLD } from '../src/extension/hooks.ts';
import { registerKnownSources } from '../src/sources/install.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { DEFAULT_LOCAL_MODEL, TransformerEmbeddingProvider } from '../src/vector/providers.ts';
import { prjctHomeFor } from '../src/workspace/project-identity.ts';

type Case = { name: string; projectId: string; query: string; relevantIds?: string[]; contains?: string; maxRank?: number; abstain?: boolean };
type Snapshot = { version: 2; source: string; models: string; indexes: string; createdAt: string };
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const casesPath = arg('--cases');
if (!casesPath) throw new Error('Usage: npm run eval:real -- --cases /private/cases.json [--workspace /private/workspace --reuse]');
const cases: Case[] = JSON.parse(await readFile(resolve(casesPath), 'utf8'));
if (!Array.isArray(cases) || !cases.length || cases.some(item => typeof item.name !== 'string'
  || typeof item.query !== 'string' || !item.query.trim() || !/^p_[A-Za-z0-9_-]+$/u.test(item.projectId)
  || (item.contains !== undefined && typeof item.contains !== 'string')
  || (item.maxRank !== undefined && (!Number.isSafeInteger(item.maxRank) || item.maxRank < 1 || item.maxRank > 6))
  || (!item.abstain && (!Array.isArray(item.relevantIds) || !item.relevantIds.length || item.relevantIds.some(id => typeof id !== 'string'))))) {
  throw new Error('Cases require name, projectId, query, and relevantIds (or abstain: true).');
}
const workspace = arg('--workspace') ? resolve(arg('--workspace')!) : await mkdtemp(join(tmpdir(), 'pi-memory-real-'));
const marker = join(workspace, 'snapshot.json');
const copy = async (source: string, destination: string, excludeIndexes = false): Promise<void> => {
  await cp(source, destination, { recursive: true, filter: async path => {
    if ((await lstat(path)).isSymbolicLink()) return false;
    return !excludeIndexes || !relative(source, path).split('/').some(part => ['memory', 'vector', 'backups'].includes(part));
  } });
};
const snapshot: Snapshot = process.argv.includes('--reuse')
  ? JSON.parse(await readFile(marker, 'utf8')) : await (async (): Promise<Snapshot> => {
    // A new snapshot must never overwrite an existing workspace.
    if (arg('--workspace')) await mkdir(workspace, { mode: 0o700 });
    const paths: Snapshot = { version: 2, source: join(workspace, 'source'),
      models: join(workspace, 'models'), indexes: join(workspace, 'indexes'), createdAt: new Date().toISOString() };
    const source = resolve(arg('--home') ?? prjctHomeFor());
    const modelCache = resolve(arg('--model-cache') ?? join(source, cases[0]!.projectId, 'memory', 'models'));
    await mkdir(paths.source, { mode: 0o700 });
    for (const projectId of [...new Set(cases.map(item => item.projectId))]) {
      await copy(join(source, projectId), join(paths.source, projectId), true);
    }
    await copy(modelCache, paths.models);
    await mkdir(paths.indexes, { mode: 0o700 });
    await writeFile(marker, JSON.stringify(paths, null, 2), { mode: 0o600 });
    return paths;
  })();
if (snapshot.version !== 2) throw new Error('Unsupported snapshot.');
const canonicalWorkspace = await realpath(workspace);
for (const path of [snapshot.source, snapshot.models, snapshot.indexes]) {
  const rel = relative(canonicalWorkspace, await realpath(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Snapshot paths must stay inside the private workspace.');
}
// Force all provider/cache and engine writes into the snapshot. Never open an
// original memory SQLite file or honor an original remote-provider config.
process.env.PRJCT_HOME = snapshot.indexes;
const engines = new Map<string, MemoryEngine>();
const engineFor = async (projectId: string): Promise<MemoryEngine> => {
  if (!engines.has(projectId)) {
    const cache = join(snapshot.indexes, projectId, 'memory', 'models');
    await mkdir(join(snapshot.indexes, projectId, 'memory'), { recursive: true, mode: 0o700 });
    await copy(snapshot.models, cache);
    engines.set(projectId, await MemoryEngine.forScope('project', projectId, 'real-eval', {
      home: snapshot.indexes, provider: new TransformerEmbeddingProvider(DEFAULT_LOCAL_MODEL, cache),
    }));
  }
  return engines.get(projectId)!;
};
const started = Date.now();
try {
  const sync = [];
  // Explicit low-level vector ingest for the document-id retrieval gate.
  // Default source sync no longer copies raw bodies; this path is not the curated daemon.
  const indexKnown = async (registry: SourceRegistry) => {
    const rows = [];
    for (const adapterId of registry.list()) {
      const adapter = registry.get(adapterId)!;
      const scanned = await registry.inspect(adapterId);
      if (adapter.scope.kind !== 'project') throw new Error('Real evaluation accepts project-local adapters only.');
      const engine = await engineFor(adapter.scope.id);
      const current = new Map([...engine.projection.eachDocumentHash()].map(row => [row.documentKey, row.contentHash]));
      const changed = scanned.documents.filter(document => current.get(documentKey(document)) !== document.contentHash);
      if (changed.length) {
        const result = await engine.indexAll(changed);
        if (!result.dense) throw new Error('Real encoder did not index every changed document.');
      }
      rows.push({ adapter: adapterId, discovered: scanned.documents.length, indexed: changed.length,
        unchanged: scanned.documents.length - changed.length, dense: changed.length, gaps: scanned.gaps });
    }
    return rows;
  };
  for (const id of [...new Set(cases.map(item => item.projectId))]) {
    const registry = new SourceRegistry();
    // This diagnostic intentionally evaluates the optional legacy publisher snapshot.
    await registerKnownSources(registry, id, { home: snapshot.source, prjct: {} });
    const first = await indexKnown(registry);
    const second = await indexKnown(registry);
    if (second.some(row => row.indexed > 0)) throw new Error('Sync is not idempotent.');
    sync.push({ projectId: id, first, second });
  }
  for (const engine of engines.values()) {
    if (engine.projection.unembeddedChunks(DEFAULT_LOCAL_MODEL).length) throw new Error(`Incomplete embedding coverage in ${engine.scopeId}.`);
  }
  const results = [];
  for (const item of cases) {
    const project = await engineFor(item.projectId);
    for (const mode of ['lexical', 'hybrid', 'automatic'] as const) {
      const automatic = mode === 'automatic';
      const found = await federatedSearch([project], { queries: [item.query], dense: mode === 'hybrid',
        limit: automatic ? 4 : 6, maxBytes: automatic ? 2200 : 12000,
        ...(automatic ? { scoreThreshold: DEFAULT_RECALL_THRESHOLD } : {}) });
      const rank = found.items.findIndex(hit => item.relevantIds?.includes(hit.id)
        && (!item.contains || hit.statement.toLowerCase().includes(item.contains.toLowerCase()))) + 1;
      const passed = item.abstain ? found.status === 'abstained' : rank > 0 && rank <= (item.maxRank ?? 3);
      results.push({ name: item.name, mode, passed, rank, status: found.status, gaps: found.gaps,
        items: found.items.map(hit => ({ id: hit.id, scopeId: hit.scopeId, namespace: hit.namespace, title: hit.title,
          score: hit.score, reason: hit.reason, excerptTruncated: hit.excerptTruncated ?? false })) });
    }
  }
  const report = { model: DEFAULT_LOCAL_MODEL, snapshot, elapsedMs: Date.now() - started,
    scopes: [...engines.values()].map(engine => ({ scopeId: engine.scopeId, stats: engine.projection.stats() })),
    sync, results, passed: results.every(result => result.passed) };
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ workspace, report: join(workspace, 'report.json'), elapsedMs: report.elapsedMs,
    passed: report.passed, results: results.map(({ name, mode, passed, rank, status }) => ({ name, mode, passed, rank, status })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  for (const engine of engines.values()) await engine.dispose();
}
