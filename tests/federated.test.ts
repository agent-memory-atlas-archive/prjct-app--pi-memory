import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { sha256 } from '../src/workspace/project-identity.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const open = async (home: string, id = 'p_test'): Promise<MemoryEngine> =>
  MemoryEngine.forScope('project', id, 's1', { home, provider: new TestEmbeddingProvider() });

const put = async (engine: MemoryEngine, externalId: string, text: string, trust: 'host' | 'imported' = 'host'): Promise<void> => {
  await engine.index({ namespace: 'test', externalId, scopeId: engine.scopeId, scopeKind: engine.scopeKind,
    source: 'fixture', kind: 'fact', text, version: sha256(text), contentHash: sha256(text),
    observedAt: '2026-01-01T00:00:00.000Z', trust, metadata: {} });
};

test('mixed-project search is rejected and team/shared engines cannot open', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-'));
  const project = await open(home, 'p_test');
  const other = await open(home, 'p_other');
  t.after(async () => { await project.dispose(); await other.dispose(); await rm(home, { recursive: true, force: true }); });
  await put(project, 'proj', 'The project stores its data in SQLite.');
  await put(other, 'other', 'OAuth refresh token rotation deadlocks on concurrent login.');
  assert.equal((await project.search({ queries: ['OAuth refresh rotation'], dense: false })).items.length, 0);
  await assert.rejects(federatedSearch([project, other], { queries: ['SQLite data storage'], dense: false }), /Mixed-project/);
  await assert.rejects(MemoryEngine.forScope('team', 't_demo', 's1', { home }), /project-owned/);
  await assert.rejects(MemoryEngine.forScope('shared', 'shared', 's1', { home }), /project-owned/);
});

test('an empty scope set abstains instead of throwing', async () => {
  const found = await federatedSearch([], { queries: ['anything'] });
  assert.equal(found.status, 'abstained');
  assert.deepEqual(found.items, []);
});

test('named answers survive generic check-ins and unrelated sources', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-value-'));
  const project = await open(home);
  t.after(async () => { await project.dispose(); await rm(home, { recursive: true, force: true }); });
  const index = async (id: string, text: string, title?: string) => project.index({
    namespace: 'test', externalId: id, scopeId: project.scopeId, scopeKind: 'project',
    source: 'prjct', kind: 'document', text, title,
    version: '1', contentHash: sha256(text), observedAt: '2026-01-01T00:00:00Z', trust: 'imported', metadata: {},
  });
  await index('answer', 'The approved design uses a versioned document contract and local embeddings.', 'Analyze pi-vector and draft its PRD');
  await index('checkin', 'What did the team decide about its next step? Report what remains and ask the team directly.', 'Team check-in');
  await index('failure', 'edit failed: the text and whitespace must match');
  const found = await federatedSearch([project], {
    queries: ['what did the team decide about pi-vector and its PRD'], dense: false, limit: 4, maxBytes: 12000,
  });
  assert.equal(found.items[0]?.id, 'answer');
});

test('a merely positive dense similarity is not evidence of an answer', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-abstain-'));
  const provider = { model: 'weak-cosine-v1', isLocal: true, embed: async (texts: readonly string[]) => texts.map(text =>
    text === 'unknown question' ? [1, 0, 0, 0, 0, 0, 0, 0] : [0.1, Math.sqrt(0.99), 0, 0, 0, 0, 0, 0]) };
  const engine = await MemoryEngine.forScope('project', 'p_test', 's1', { home, provider });
  t.after(async () => { await engine.dispose(); await rm(home, { recursive: true, force: true }); });
  await put(engine, 'noise', 'Unrelated retained document.');
  const result = await federatedSearch([engine], { queries: ['unknown question'], dense: true });
  assert.equal(result.status, 'abstained');
  assert.deepEqual(result.items, []);
});

test('a matching heading brings its adjacent evidence instead of an empty preview', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-window-'));
  const engine = await open(home);
  t.after(async () => { await engine.dispose(); await rm(home, { recursive: true, force: true }); });
  const text = `Orion storage decision\n\nDecision: persist in SQLite with WAL. ${'Rationale and implementation details. '.repeat(45)}`;
  await put(engine, 'design', text);
  const found = await federatedSearch([engine], { queries: ['Orion storage decision'], dense: false, maxBytes: 4000 });
  assert.match(found.items[0]!.statement, /persist in SQLite/);
  assert.ok(found.items[0]!.contextChunkIds!.length > 1);
});

test('filtered recall replenishes candidates hidden behind an excluded namespace', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-filter-'));
  const engine = await open(home);
  t.after(async () => { await engine.dispose(); await rm(home, { recursive: true, force: true }); });
  const docs = Array.from({ length: 90 }, (_, index) => {
    const text = `SQLite backup ${index}`;
    return { namespace: 'noise', externalId: `n-${index}`, scopeId: engine.scopeId, scopeKind: 'project' as const,
      source: 'fixture', kind: 'fact', text, version: '1', contentHash: sha256(text),
      observedAt: '2026-01-01T00:00:00Z', trust: 'host' as const, metadata: {} };
  });
  await engine.indexAll(docs);
  const text = `SQLite backup procedure: ${'preserve the WAL and verify the restored database. '.repeat(10)}`;
  await engine.index({ ...docs[0]!, namespace: 'manual', externalId: 'answer', text, contentHash: sha256(text) });
  const found = await federatedSearch([engine], { queries: ['SQLite backup'], namespaces: ['manual'], dense: false, limit: 1 });
  assert.equal(found.items[0]?.id, 'answer');
});

test('a tight byte budget preserves the top evidence and marks a shortened excerpt', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-bytes-'));
  const engine = await open(home);
  t.after(async () => { await engine.dispose(); await rm(home, { recursive: true, force: true }); });
  await put(engine, 'answer', `SQLite backup decision: preserve the WAL. ${'Evidence áéí 日本語. '.repeat(100)}`);
  const found = await federatedSearch([engine], { queries: ['answer'], dense: false, limit: 1, maxBytes: 512 });
  assert.equal(found.items[0]?.id, 'answer');
  assert.equal(found.items[0]?.excerptTruncated, true);
  assert.equal(found.status, 'partial');
  assert.ok(Buffer.byteLength(JSON.stringify(found.items)) <= 512);
  assert.ok(!found.items[0]!.statement.includes('\uFFFD'));
});
