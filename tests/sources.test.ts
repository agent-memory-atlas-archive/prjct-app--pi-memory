import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { discoverTeams, teamMailboxRoot } from '../src/sources/discovery.ts';
import { registerKnownSources, scopedEngines } from '../src/sources/install.ts';
import { prjctObservationSource, teamArtifactSource, teamJournalSource } from '../src/sources/presets.ts';
import { JsonRecordAdapter } from '../src/sources/records.ts';
import { SourceRegistry, type SourceAdapter } from '../src/sources/registry.ts';
import { firstTimestamp, selects, valuesAt } from '../src/sources/shape.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const observation = (id: string, fields: Record<string, unknown>) => ({
  id, provenance: 'native_observation', summary: `summary for ${id}`,
  recordedAt: '2026-01-01T00:00:00.000Z', ...fields,
});

const writeObservations = async (home: string, projectId: string, observations: readonly unknown[]): Promise<void> => {
  const dir = join(home, projectId, 'prjct', 'work', 'sessions', '20260101', 'session_123');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'writer.json'), JSON.stringify({ payload: { observations } }));
};

const writeTeam = async (root: string, mailbox: string, id: string, name: string): Promise<void> => {
  await mkdir(join(root, 'teams', id), { recursive: true });
  await writeFile(join(root, 'teams', id, 'settings.json'), JSON.stringify({ schemaVersion: 1, scope: 'team', id, name }));
  const journal = join(mailbox, name, 'journal');
  await mkdir(journal, { recursive: true });
  await writeFile(join(journal, '2026-01-01.jsonl'), `${[
    JSON.stringify({ v: 1, type: 'thread', at: Date.parse('2026-01-01'), team: name, rootId: `r-${id}`, subject: `Login ${name}`,
      requested: 'Fix auth', delivered: 'Fixed OAuth', outcome: 'completed', files: ['src/auth.ts'], tests: ['npm test'] }),
    JSON.stringify({ v: 1, type: 'message', at: Date.parse('2026-01-01'), team: name, id: `m-${id}`, rootId: `r-${id}`, body: 'on it' }),
    JSON.stringify({ v: 1, type: 'control', at: Date.parse('2026-01-01'), team: name, controlId: `c-${id}`, action: 'pause', state: 'done' }),
  ].join('\n')}\n`);
  const artifacts = join(root, 'teams', id, 'team', 'artifacts');
  await mkdir(join(artifacts, 'index'), { recursive: true });
  await mkdir(join(artifacts, 'blobs'), { recursive: true });
  const sha = createHash('sha256').update(id).digest('hex');
  await writeFile(join(artifacts, 'index', '2026-01-01.jsonl'), `${JSON.stringify({ v: 1, at: Date.parse('2026-01-01'),
    artifactId: `a-${id}`, sha, path: `/repo/${name}.ts`, name: `${name}.ts`, alias: 'dev', tool: 'edit', bytes: 12, stored: true })}\n`);
  await writeFile(join(artifacts, 'blobs', sha), `export const ${name} = true`);
};

test('field access reaches nested paths, fans out on *, and reads any timestamp shape', () => {
  const record = { a: { b: [{ c: 1 }, { c: 2 }] }, at: 1_767_225_600_000, secs: 1_767_225_600, iso: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(valuesAt(record, 'a.b.*.c'), [1, 2]);
  assert.deepEqual(valuesAt(record, 'a.b.1.c'), [2]);
  assert.deepEqual(valuesAt(record, 'a.missing.c'), []);
  // Epoch milliseconds, epoch seconds and ISO all resolve to the same instant.
  const stamps = ['at', 'secs', 'iso'].map(field => firstTimestamp(record, [field]));
  assert.equal(new Set(stamps).size, 1);
});

test('selection rules are data: keep is a disjunction, drop vetoes it', () => {
  const rules = { keep: [{ field: 'kind', equals: 'failure' }, { field: 'tool', oneOf: ['user_input'] }], drop: [{ field: 'noisy', equals: true }] };
  assert.equal(selects({ kind: 'failure' }, rules), true);
  assert.equal(selects({ tool: 'user_input' }, rules), true);
  assert.equal(selects({ kind: 'note' }, rules), false);
  assert.equal(selects({ kind: 'failure', noisy: true }, rules), false);
  assert.equal(selects({ anything: 1 }, {}), true);
});

test('an unknown publisher is indexed from its conventional field names alone', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-any-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested', 'a.jsonl'), `${[
    JSON.stringify({ uuid: 'x1', body: 'a decision about caching', title: 'Caching', timestamp: 1_767_225_600_000, category: 'decision' }),
    JSON.stringify({ key: 'x2', content: 'another note', createdAt: '2026-01-02T00:00:00.000Z' }),
  ].join('\n')}\n`);
  // No mapping beyond a namespace: ids, text, titles, times and kinds are found
  // under the names records conventionally use.
  const docs = await new JsonRecordAdapter({ id: 'any', scope: { kind: 'project', id: 'p_test' }, root,
    mapping: { namespace: 'other.thing' } }).scan();
  assert.deepEqual(docs.map(doc => doc.externalId).sort(), ['x1', 'x2']);
  const first = docs.find(doc => doc.externalId === 'x1')!;
  assert.equal(first.title, 'Caching');
  assert.equal(first.kind, 'decision');
  assert.equal(first.text, 'a decision about caching');
  assert.equal(first.observedAt, '2026-01-01T00:00:00.000Z');
});

test('a mapping overrides detection without touching adapter code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'weird.json'), JSON.stringify({
    envelope: { items: [{ ref: 'w1', blurb: 'unusual shape', when: 1_767_225_600, level: 'high' }] },
  }));
  const docs = await new JsonRecordAdapter({ id: 'weird', scope: { kind: 'team', id: 't_x' }, root, depth: 0,
    mapping: { namespace: 'weird', container: 'envelope.items', id: ['ref'], text: ['blurb'], observedAt: ['when'],
      kind: { from: ['level'] }, trust: { from: 'level', when: { high: 'host' }, fallback: 'agent' },
      metadata: { level: 'level' } } }).scan();
  assert.equal(docs.length, 1);
  assert.deepEqual([docs[0]!.externalId, docs[0]!.kind, docs[0]!.trust, docs[0]!.metadata.level], ['w1', 'high', 'host', 'high']);
});

test('prjct preset keeps failures, verifications and user statements, dropping routine reads', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-source-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeObservations(home, 'p_test', [
    observation('obs_fail', { execution: { toolName: 'bash', outcome: 'failed', sourcePaths: ['src/auth.ts'] } }),
    observation('obs_said', { execution: { toolName: 'user_input', outcome: 'succeeded' } }),
    observation('obs_read', { execution: { toolName: 'read', outcome: 'succeeded' } }),
    observation('obs_ok', { execution: { toolName: 'bash', outcome: 'succeeded', command: 'ls' } }),
    observation('obs_verified', { verification: true, execution: { toolName: 'bash', outcome: 'succeeded' } }),
  ]);
  const scope = { kind: 'project', id: 'p_test' } as const;
  const docs = await prjctObservationSource({ home, scope }).scan();
  assert.deepEqual(docs.map(doc => doc.externalId).sort(), ['obs_fail', 'obs_said', 'obs_verified']);
  assert.equal(docs.find(doc => doc.externalId === 'obs_fail')?.trust, 'host');
  // Kind comes from rules over the record, not from a hard-coded branch.
  assert.deepEqual(docs.map(doc => [doc.externalId, doc.kind]).sort(),
    [['obs_fail', 'failure'], ['obs_said', 'instruction'], ['obs_verified', 'verification']]);
  assert.match(docs.find(doc => doc.externalId === 'obs_fail')!.text, /Paths: src\/auth\.ts/);

  // The policy is a rule set the caller supplies, not a taste baked into code.
  const everything = await prjctObservationSource({ home, scope, select: { keep: [{ field: 'id', exists: true }] } }).scan();
  assert.equal(everything.length, 5);
  const onlyReads = await prjctObservationSource({ home, scope, select: { keep: [{ field: 'execution.toolName', equals: 'read' }] } }).scan();
  assert.deepEqual(onlyReads.map(doc => doc.externalId), ['obs_read']);
});

test('team scopes are discovered from prjct markers, binding id to name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-discover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mailbox = join(root, 'agent-teams');
  await writeTeam(root, mailbox, 't_alpha', 'alpha');
  await writeTeam(root, mailbox, 't_beta', 'beta');
  await mkdir(join(root, 'teams', 'not-a-team'), { recursive: true });
  assert.deepEqual(await discoverTeams(root), [{ id: 't_alpha', name: 'alpha' }, { id: 't_beta', name: 'beta' }]);
});

test('team preset indexes settled threads and artifacts, not message traffic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mailbox = join(root, 'agent-teams');
  await writeTeam(root, mailbox, 't_demo', 'demo');
  const scope = { kind: 'team', id: 't_demo' } as const;
  const journal = await teamJournalSource({ mailboxRoot: mailbox, teamName: 'demo', scope }).scan();
  assert.deepEqual(journal.map(doc => doc.externalId), ['r-t_demo']);
  assert.equal(journal[0]?.kind, 'thread');
  assert.match(journal[0]!.text, /Delivered: Fixed OAuth/);
  assert.match(journal[0]!.text, /Tests: npm test/);
  const artifacts = await teamArtifactSource({ home: root, scope }).scan();
  assert.deepEqual(artifacts.map(doc => doc.externalId), ['a-t_demo']);
  assert.equal(artifacts[0]?.text, 'export const demo = true');
  assert.equal([...journal, ...artifacts].every(doc => doc.scopeId === 't_demo' && doc.scopeKind === 'team'), true);
});

test('a team adapter cannot be synced into a project engine', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-scope-'));
  const mailbox = join(root, 'agent-teams');
  await writeTeam(root, mailbox, 't_alpha', 'alpha');
  const engineRoot = await mkdtemp(join(tmpdir(), 'pi-memory-engine-'));
  const project = new MemoryEngine({ root: engineRoot, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await project.dispose(); await rm(root, { recursive: true, force: true }); await rm(engineRoot, { recursive: true, force: true }); });
  const registry = new SourceRegistry();
  registry.register(teamJournalSource({ mailboxRoot: mailbox, teamName: 'alpha', scope: { kind: 'team', id: 't_alpha' } }));
  await assert.rejects(registry.sync(async () => project, 'pi-team:t_alpha:journal'),
    /targets team\/t_alpha but the engine owns project\/p_test/);
});

test('the registry refuses an adapter whose documents escape its declared scope', async t => {
  const engineRoot = await mkdtemp(join(tmpdir(), 'pi-memory-escape-'));
  const project = new MemoryEngine({ root: engineRoot, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await project.dispose(); await rm(engineRoot, { recursive: true, force: true }); });
  const rogue: SourceAdapter = {
    id: 'rogue', scope: { kind: 'project', id: 'p_test' },
    scan: async () => [{ namespace: 'test', externalId: 'x', scopeId: 'p_other', scopeKind: 'project',
      source: 'test', kind: 'document', text: 'leak', version: 'v1', contentHash: 'b'.repeat(64),
      observedAt: '2026-01-01T00:00:00.000Z', trust: 'host', metadata: {} }],
  };
  const registry = new SourceRegistry();
  registry.register(rogue);
  await assert.rejects(registry.sync(async () => project, 'rogue'), /outside its own scope/);
});

test('sync routes each adapter to the scope that owns it and is idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mailbox = join(root, 'agent-teams');
  await writeObservations(root, 'p_test', [observation('obs_fail', { execution: { toolName: 'bash', outcome: 'failed' } })]);
  await writeTeam(root, mailbox, 't_demo', 'demo');

  const project = await MemoryEngine.forScope('project', 'p_test', 's1', { home: root, provider: new TestEmbeddingProvider() });
  const registry = new SourceRegistry();
  await registerKnownSources(registry, 'p_test', { home: root, mailboxRoot: mailbox });
  assert.deepEqual(registry.list(), ['pi-team:t_demo:artifacts', 'pi-team:t_demo:journal', 'prjct-observations']);

  const engines = scopedEngines('s1', project, { home: root });
  t.after(() => engines.dispose());
  const first = await registry.syncAll(engines.resolve);
  assert.deepEqual(first.map(r => [r.adapter, r.indexed]), [
    ['pi-team:t_demo:artifacts', 1], ['pi-team:t_demo:journal', 1], ['prjct-observations', 1]]);
  const second = await registry.syncAll(engines.resolve);
  assert.deepEqual(second.map(r => [r.adapter, r.indexed, r.unchanged]), [
    ['pi-team:t_demo:artifacts', 0, 1], ['pi-team:t_demo:journal', 0, 1], ['prjct-observations', 0, 1]]);

  assert.equal(project.projection.stats().documents, 1);
  const team = await MemoryEngine.forScope('team', 't_demo', 's1', { home: root, provider: new TestEmbeddingProvider() });
  t.after(() => team.dispose());
  assert.equal(team.projection.stats().documents, 2);
  assert.equal((await team.search({ queries: ['Fixed OAuth auth'], dense: false, limit: 5 })).items.length > 0, true);
});

test('an extra adapter can be registered without changing pi-memory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-extra-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const custom = new JsonRecordAdapter({ id: 'my-source', scope: { kind: 'project', id: 'p_test' },
    root, mapping: { namespace: 'my.source' } });
  const registry = new SourceRegistry();
  await registerKnownSources(registry, 'p_test', { home: root, teams: false, extra: [custom] });
  assert.deepEqual(registry.list(), ['my-source', 'prjct-observations']);
});

test('the mailbox root follows the Pi agent directory, not PRJCT_HOME', () => {
  assert.equal(teamMailboxRoot('/explicit'), '/explicit');
  assert.match(teamMailboxRoot(), /teams$/);
});
