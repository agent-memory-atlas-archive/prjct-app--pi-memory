import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { federatedSearch } from '../src/retrieval/federated.ts';
import { sha256 } from '../src/workspace/project-identity.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const open = async (home: string, kind: 'project' | 'team' | 'shared', id: string): Promise<MemoryEngine> =>
  MemoryEngine.forScope(kind, id, 's1', { home, provider: new TestEmbeddingProvider() });

const put = async (engine: MemoryEngine, externalId: string, text: string): Promise<void> => {
  await engine.index({ namespace: 'test', externalId, scopeId: engine.scopeId, scopeKind: engine.scopeKind,
    source: 'fixture', kind: 'fact', text, version: sha256(text), contentHash: sha256(text),
    observedAt: '2026-01-01T00:00:00.000Z', trust: 'host', metadata: {} });
};

test('search reaches team and shared scopes, not just the project', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-'));
  const project = await open(home, 'project', 'p_test');
  const team = await open(home, 'team', 't_demo');
  const shared = await open(home, 'shared', 'shared');
  t.after(async () => { for (const e of [project, team, shared]) await e.dispose(); await rm(home, { recursive: true, force: true }); });

  await put(project, 'proj', 'The project stores its data in SQLite.');
  await put(team, 'team', 'OAuth refresh token rotation deadlocks on concurrent login.');
  await put(shared, 'shared', 'The interface uses high contrast typography.');

  // Each scope alone answers only its own question.
  assert.equal((await project.search({ queries: ['OAuth refresh rotation'], dense: false })).items.length, 0);

  const engines = [project, team, shared];
  const oauth = await federatedSearch(engines, { queries: ['OAuth refresh rotation deadlock'], dense: false, limit: 5 });
  assert.deepEqual(oauth.items.map(item => item.id), ['team']);
  const typography = await federatedSearch(engines, { queries: ['high contrast typography'], dense: false, limit: 5 });
  assert.deepEqual(typography.items.map(item => item.id), ['shared']);
  const sqlite = await federatedSearch(engines, { queries: ['SQLite data storage'], dense: false, limit: 5 });
  assert.deepEqual(sqlite.items.map(item => item.id), ['proj']);
});

test('the project outranks other scopes when the match is equally good', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-rank-'));
  const project = await open(home, 'project', 'p_test');
  const team = await open(home, 'team', 't_demo');
  t.after(async () => { for (const e of [project, team]) await e.dispose(); await rm(home, { recursive: true, force: true }); });
  // Identical text in both scopes: only the scope prior can separate them.
  const text = 'The deployment runs from the release tag after checks pass.';
  await put(project, 'here', text);
  await put(team, 'there', text);
  const found = await federatedSearch([team, project], { queries: ['deployment release tag checks'], dense: false, limit: 5 });
  assert.deepEqual(found.items.map(item => item.id), ['here', 'there']);
});

test('a scope that cannot be searched is a gap, not a failure', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-fed-fail-'));
  const project = await open(home, 'project', 'p_test');
  t.after(async () => { await project.dispose(); await rm(home, { recursive: true, force: true }); });
  await put(project, 'proj', 'The project stores its data in SQLite.');
  const broken = { scopeId: 't_broken', scopeKind: 'team' as const,
    search: async () => { throw new Error('projection is unreadable'); } } as unknown as MemoryEngine;
  const found = await federatedSearch([project, broken], { queries: ['SQLite data'], dense: false, limit: 5 });
  assert.deepEqual(found.items.map(item => item.id), ['proj']);
  assert.equal(found.status, 'partial');
  assert.match(found.gaps.join(' '), /team\/t_broken is unavailable: projection is unreadable/);
});

test('scopes are searched concurrently, so cost is the slowest not the sum', async t => {
  const slow = (id: string): MemoryEngine => ({
    scopeId: id, scopeKind: 'team' as const,
    search: async () => { await new Promise(resolve => setTimeout(resolve, 120)); return { status: 'abstained', items: [], gaps: [], omitted: 0 }; },
  } as unknown as MemoryEngine);
  const started = Date.now();
  await federatedSearch([slow('a'), slow('b'), slow('c'), slow('d'), slow('e')], { queries: ['x'], dense: false });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `five 120ms scopes should overlap, took ${elapsed}ms`);
});

test('an empty scope set abstains instead of throwing', async () => {
  const found = await federatedSearch([], { queries: ['anything'] });
  assert.equal(found.status, 'abstained');
  assert.deepEqual(found.items, []);
});
