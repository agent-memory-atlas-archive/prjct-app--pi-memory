import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { documentKey, parseDocumentKey } from '../src/contracts/documents.ts';
import { MemoryEngine } from '../src/engine.ts';
import { DEFAULT_RECALL_THRESHOLD } from '../src/extension/hooks.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { teamArtifactMapping } from '../src/sources/presets.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { DEFAULT_LOCAL_MODEL, TransformerEmbeddingProvider } from '../src/vector/providers.ts';
import { sha256 } from '../src/workspace/project-identity.ts';

// Uses a real-data evaluation snapshot as READ-ONLY input. Every lifecycle
// mutation, model/cache write, journal and SQLite index goes into a new sandbox.
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
if (!arg('--workspace') || !arg('--case')) throw new Error('Usage: npm run eval:freshness -- --workspace /private/snapshot --case /private/freshness-case.json');
const baseline = await realpath(resolve(arg('--workspace')!));
const snapshot: { version: number; source: string; models: string } = JSON.parse(await readFile(join(baseline, 'snapshot.json'), 'utf8'));
if (snapshot.version !== 1) throw new Error('Unsupported snapshot.');
for (const path of [snapshot.source, snapshot.models]) {
  const rel = relative(baseline, await realpath(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Input paths must stay inside the private snapshot.');
}
const item: { scopeId: string; documentId: string; query: string; contains?: string } = JSON.parse(await readFile(resolve(arg('--case')!), 'utf8'));
if (!/^t_[A-Za-z0-9_-]+$/u.test(item.scopeId) || typeof item.documentId !== 'string' || !item.documentId.trim()
  || typeof item.query !== 'string' || !item.query.trim() || item.contains !== undefined && typeof item.contains !== 'string') throw new Error('Invalid freshness case.');
const artifacts = join(snapshot.source, 'teams', item.scopeId, 'team', 'artifacts');
type Artifact = { artifactId: string; sha: string; at: number; name: string; stored: boolean; bytes: number; [key: string]: unknown };
const rows: Artifact[] = (await Promise.all((await readdir(join(artifacts, 'index'))).filter(name => name.endsWith('.jsonl')).sort().map(async name =>
  (await readFile(join(artifacts, 'index', name), 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line))))).flat();
const original = rows.filter(row => row.artifactId === item.documentId).sort((a, b) => b.at - a.at)[0];
if (!original?.stored || !/^[a-f0-9]{64}$/u.test(original.sha) || !Number.isFinite(original.at)) throw new Error('Case must name a stored, dated real artifact.');
const root = await mkdtemp(join(tmpdir(), 'pi-memory-freshness-real-'));
const records = join(root, 'records');
const blobs = join(root, 'blobs');
await mkdir(records); await mkdir(blobs);
await cp(join(artifacts, 'blobs', original.sha), join(blobs, original.sha));
await cp(snapshot.models, join(root, 'models'), { recursive: true, filter: async path => !(await lstat(path)).isSymbolicLink() });
const body = await readFile(join(blobs, original.sha), 'utf8');
const recordPath = join(records, 'artifact.jsonl');
const publish = (values: readonly Artifact[]) => writeFile(recordPath, values.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
await publish([original]);
process.env.PRJCT_HOME = join(root, 'indexes');
const scope = { kind: 'team' as const, id: item.scopeId };
const engine = await MemoryEngine.forScope(scope.kind, scope.id, 'freshness-real', {
  home: process.env.PRJCT_HOME, provider: new TransformerEmbeddingProvider(DEFAULT_LOCAL_MODEL, join(root, 'models')),
});
const registry = new SourceRegistry();
registry.register(new JsonRecordAdapter({ id: 'real-artifact', scope, source: 'pi-team', root: records, mapping: teamArtifactMapping(blobs) }));
// Explicit low-level vector copy for the identity-anchored document lifecycle gate.
// Default SourceRegistry.sync no longer copies raw bodies.
const sync = async () => {
  const adapter = registry.get('real-artifact')!;
  const snapshot = await registry.inspect('real-artifact');
  const current = new Map([...engine.projection.eachDocumentHash()].map(row => [row.documentKey, row]));
  const collision = snapshot.documents.find(document => {
    const owner = current.get(documentKey(document))?.adapter;
    return owner !== undefined && owner !== adapter.id;
  });
  if (collision) throw new Error(`Adapter ${adapter.id} cannot overwrite another adapter's document.`);
  const changed = snapshot.documents.filter(document => current.get(documentKey(document))?.revision !== document.sync?.revision
    || current.get(documentKey(document))?.contentHash !== document.contentHash);
  const totals = { dense: 0 };
  if (changed.length) {
    const result = await engine.indexAll(changed);
    if (result.dense) totals.dense = changed.length;
  }
  const seen = new Set(snapshot.documents.map(documentKey));
  const removed = snapshot.complete ? [...current.values()].filter(row => row.adapter === adapter.id && !seen.has(row.documentKey)) : [];
  for (const row of removed) {
    const identity = parseDocumentKey(row.documentKey);
    await engine.remove(identity.namespace, identity.externalId, `Absent from complete source snapshot: ${adapter.id}`);
  }
  return { indexed: changed.length, dense: totals.dense, removed: removed.length, gaps: snapshot.gaps };
};
const cutoff = new Date(original.at + 86_400_000).toISOString();
const before = new Date(Date.parse(cutoff) - 1).toISOString();
const now = new Date(original.at + 10 * 86_400_000).toISOString();
const checks: { phase: string; mode: string; passed: boolean; present: boolean; status: string; gaps: readonly string[] }[] = [];
const check = async (phase: string, expected: boolean, asOf = now, partial = false): Promise<void> => {
  for (const mode of ['lexical', 'hybrid', 'automatic'] as const) {
    const automatic = mode === 'automatic';
    const result = await federatedSearch([engine], { queries: [item.query], asOf, dense: mode === 'hybrid',
      maxBytes: automatic ? 2200 : 12000, limit: automatic ? 4 : 6,
      ...(automatic ? { scoreThreshold: DEFAULT_RECALL_THRESHOLD } : {}) });
    const hit = result.items.find(hit => hit.id === item.documentId);
    const content = !item.contains || hit?.statement.toLowerCase().includes(item.contains.toLowerCase());
    const passed = Boolean(hit) === expected && (!expected || Boolean(content)) && (!partial || result.status === 'partial');
    checks.push({ phase, mode, passed, present: Boolean(hit), status: result.status, gaps: result.gaps });
  }
};
const started = Date.now();
try {
  assert.equal((await sync()).dense, 1, 'The real local encoder must embed the document.');
  await check('original real content', true);
  await publish([{ ...original, validTo: cutoff }]);
  assert.equal((await sync()).indexed, 1, 'Validity-only amendments must invalidate the sync fingerprint.');
  await check('expired at exact cutoff', false, cutoff);
  await check('historical millisecond before cutoff', true, before);
  assert.equal((await sync()).indexed, 0);
  await engine.rebuild();
  assert.equal((await sync()).indexed, 0, 'Rebuild must retain source revision/ownership.');
  await check('expiration survives rebuild', false);

  // A new revision contains the real text plus an explicitly synthetic footer.
  // No fabricated decision is inserted into the original PRD or source store.
  const replacementBody = `${body}\n\nTemporal validation revision marker (simulated).\n`;
  const replacementHash = sha256(replacementBody);
  await writeFile(join(blobs, replacementHash), replacementBody, { mode: 0o600 });
  const replacement: Artifact = { ...original, at: original.at + 2 * 86_400_000, sha: replacementHash, bytes: Buffer.byteLength(replacementBody) };
  await publish([original, replacement]);
  await sync();
  assert.equal(engine.projection.documentByKey({ namespace: 'pi-team.artifact', externalId: item.documentId })?.contentHash, replacementHash);
  await check('replacement body is current', true);
  await check('replacement cannot masquerade as older revision', false, before);

  await publish([original]); await sync();
  await writeFile(recordPath, '{"artifactId":');
  await assert.rejects(sync());
  await check('corrupt source retained with warning', true, now, true);
  await rename(records, `${records}-offline`);
  assert.equal((await sync()).removed, 0);
  await check('unavailable source retained with warning', true, now, true);
  await rename(`${records}-offline`, records);
  await publish([original]); await sync();
  await rm(join(blobs, original.sha));
  assert.equal((await sync()).removed, 0);
  await check('missing blob retained with warning', true, now, true);
  await cp(join(artifacts, 'blobs', original.sha), join(blobs, original.sha));
  await sync();

  await publish([original, { ...replacement, stored: false }]);
  assert.equal((await sync()).removed, 1);
  await check('newest excluded revision cannot resurrect older content', false);
  await publish([original]); await sync();
  await rm(recordPath);
  assert.equal((await sync()).removed, 1);
  await check('source record removed', false);
  await engine.rebuild();
  await check('retirement survives rebuild', false);

  const report = { root, baseline, case: item, model: DEFAULT_LOCAL_MODEL, title: original.name, bodyHash: sha256(body),
    lifecycleIsSimulated: true, originalSourcesAndIndexesUntouched: true, elapsedMs: Date.now() - started,
    checks, passed: checks.every(check => check.passed) };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ workspace: root, report: join(root, 'report.json'), passed: report.passed,
    checks: checks.length, failed: checks.filter(check => !check.passed), elapsedMs: report.elapsedMs }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await engine.dispose();
}
