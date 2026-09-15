import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MemoryEngine } from '../src/engine.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { MEMORY_DATABASE, memoryDatabasePath } from '../src/workspace/project-identity.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const open = (home: string, id: string, storage: 'auto' | 'indexed' = 'auto'): Promise<MemoryEngine> =>
  MemoryEngine.forScope('project', id, 's1', { home, provider: new TestEmbeddingProvider(), storage });

test('each project owns a separate memory.sqlite and cannot open another project', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-iso-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const a = await open(home, 'p_aaa');
  const b = await open(home, 'p_bbb');
  t.after(async () => { await a.dispose(); await b.dispose(); });
  await a.recordFact({ kind: 'decision', statement: 'Project A stores secrets in vault-a.', entities: [], evidence: [], episodeIds: [], confidence: 0.9, tags: {} });
  await b.recordFact({ kind: 'decision', statement: 'Project B stores secrets in vault-b.', entities: [], evidence: [], episodeIds: [], confidence: 0.9, tags: {} });
  assert.equal(a.projection.path, memoryDatabasePath(home, 'p_aaa'));
  assert.equal(b.projection.path, memoryDatabasePath(home, 'p_bbb'));
  assert.notEqual(a.projection.path, b.projection.path);
  assert.ok(a.projection.path.endsWith(MEMORY_DATABASE));
  assert.equal((await a.search({ queries: ['vault-a'], dense: false })).items.length, 1);
  assert.equal((await a.search({ queries: ['vault-b'], dense: false })).items.length, 0);
  assert.equal((await b.search({ queries: ['vault-a'], dense: false })).items.length, 0);
  await assert.rejects(MemoryEngine.forTeam('t_demo', 's1', { home }), /project-owned/);
  await assert.rejects(MemoryEngine.forShared('s1', { home }), /project-owned/);
  await assert.rejects(federatedSearch([a, b], { queries: ['vault'], dense: false }), /Mixed-project/);
});

test('ownership is claimed in sqlite and a colliding id cannot bind the other database', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-own-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const a = await open(home, 'p_aaa');
  t.after(() => a.dispose());
  const stolen = join(home, 'p_aaa', 'memory');
  assert.throws(() => new MemoryEngine({
    root: stolen, scopeId: 'p_bbb', sessionId: 's1', provider: new TestEmbeddingProvider(),
  }), /owned by another project/);
});

test('contradictory knowledge in A is invisible to B including inspect and feedback', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-iso-ab-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const a = await open(home, 'p_aaa');
  const b = await open(home, 'p_bbb');
  t.after(async () => { await a.dispose(); await b.dispose(); });
  const recorded = await a.recordFact({
    kind: 'decision', statement: 'Project A vault-alpha-only uses the north datastore.', entities: [], evidence: [], episodeIds: [],
    confidence: 0.9, tags: {},
  });
  await b.recordFact({
    kind: 'decision', statement: 'Project B vault-bravo-only uses the south datastore.', entities: [], evidence: [], episodeIds: [],
    confidence: 0.9, tags: {},
  });
  assert.equal((await a.search({ queries: ['vault-bravo-only'], dense: false })).items.length, 0);
  assert.equal((await b.search({ queries: ['vault-alpha-only'], dense: false })).items.length, 0);
  assert.equal(b.projection.getFact(recorded.fact.id), undefined);
  await assert.rejects(b.feedback(recorded.fact.id, 'wrong', 'sqlite'), /Unknown memory/);
});

test('a competing process can open a migrated database while a writer holds BEGIN IMMEDIATE', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-iso5b-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const engine = await open(home, 'p_iso5b', 'indexed');
  t.after(() => engine.dispose());
  engine.projection.db.exec('BEGIN IMMEDIATE');
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./open-engine-child.mts', import.meta.url)), home, 'p_iso5b'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { out: '', err: '' };
  child.stdout.on('data', chunk => { output.out += String(chunk); });
  child.stderr.on('data', chunk => { output.err += String(chunk); });
  const code: number | null = await new Promise(resolve => child.on('close', resolve));
  engine.projection.db.exec('ROLLBACK');
  assert.equal(code, 0, `competing opener crashed: ${output.err || output.out}`);
  assert.match(output.out, /opened-ok/);
});

test('embedding caches cannot escape or symlink outside the project authority', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-cache-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const outside = join(home, 'outside');
  await mkdir(outside);
  const configured = join(home, 'p_configured', 'memory');
  await mkdir(configured, { recursive: true });
  await writeFile(join(configured, 'config.json'), JSON.stringify({ cacheDir: outside }));
  await assert.rejects(MemoryEngine.forScope('project', 'p_configured', 's1', { home }), /escaped the project authority/);

  const linked = join(home, 'p_linked', 'memory');
  await mkdir(linked, { recursive: true });
  await symlink(outside, join(linked, 'models'), 'dir');
  await assert.rejects(MemoryEngine.forScope('project', 'p_linked', 's1', { home }), /outside the project authority/);
});

test('a symlink into another project is rejected', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-link-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const a = await open(home, 'p_aaa');
  t.after(() => a.dispose());
  const target = join(home, 'p_bbb', 'memory');
  await symlink(join(home, 'p_aaa', 'memory'), target, 'dir').catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(home, 'p_bbb'), { recursive: true });
    await symlink(join(home, 'p_aaa', 'memory'), target, 'dir');
  });
  await assert.rejects(open(home, 'p_bbb'), /another project|exclusive database|escaped/);
});
