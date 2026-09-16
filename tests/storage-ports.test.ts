import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.ts';
import { Projection } from '../src/storage/projection.ts';
import { CurationStore } from '../src/curation/store.ts';
import { claimMemoryOwner } from '../src/storage/migrations.ts';
import { CompactStore } from '../src/storage/compact-store.ts';
import { IndexedAuthority, type AuthorityPort, type JournalPort } from '../src/storage/ports.ts';
import { MemoryJournal } from '../src/storage/journal.ts';
import { TestEmbeddingProvider } from './helpers.ts';

// The boundary is only real if orchestration cannot reach the driver behind it.
test('orchestration owns no raw connection, transaction or vacuum statements', async () => {
  for (const path of ['../src/engine.ts', '../src/curation/publish.ts', '../src/curation/migrate.ts', '../src/curation/pipeline.ts']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.equal(/\.(projection|curation)\.db\b/.test(source), false, `${path} reaches the raw connection`);
    // Prose may still describe the legacy checkpoint; executing SQL may not.
    const executed = source.split('\n').filter(line => /\.(exec|prepare)\(/.test(line));
    assert.equal(executed.some(line => /BEGIN IMMEDIATE|\bCOMMIT\b|ROLLBACK|VACUUM/.test(line)), false, `${path} issues raw transaction control`);
  }
});

test('indexed and compact authorities satisfy one port contract with identical nesting semantics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projection = new Projection(join(root, 'indexed.sqlite'));
  claimMemoryOwner(projection.db, 'p_ports');
  const curation = new CurationStore(projection.db, join(root, 'indexed.sqlite'));
  const compact = new CompactStore(join(root, 'compact.sqlite'), 'p_ports');
  const ports: AuthorityPort[] = [new IndexedAuthority(projection, curation), compact];
  t.after(() => { curation.close(); projection.close(); compact.close(); });
  for (const port of ports) {
    assert.equal(port.transaction(() => port.transaction(() => 'nested')), 'nested');
    assert.throws(() => port.transaction(() => { throw new Error('rolled back'); }), /rolled back/);
    assert.equal(typeof port.checkpoint(), 'string');
  }
  const journals: JournalPort[] = [new MemoryJournal(root, 'p_ports', 's1')];
  for (const journal of journals) {
    assert.equal(typeof journal.sessionId, 'string');
    assert.equal(typeof journal.writerId, 'string');
    assert.equal((await journal.readAll()).length, 0);
  }
});

test('engine authority transactions route through the port and keep all-or-nothing behaviour', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ports-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = new MemoryEngine({ root, scopeId: 'p_ports', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const calls: string[] = [];
  const port = engine.authority;
  const original = port.transaction.bind(port);
  (engine as unknown as { authority: AuthorityPort }).authority = {
    transaction: (action: () => unknown) => { calls.push('transaction'); return original(action as never); },
    checkpoint: () => port.checkpoint(),
  } as AuthorityPort;
  const fact = engine.composeFact({ kind: 'fact', statement: 'Ports keep the boundary honest.', confidence: 1,
    evidence: [], entities: [], episodeIds: [], tags: {} });
  engine.authorityTransaction(() => engine.commitAuthority({ type: 'fact.recorded', fact }));
  assert.deepEqual(calls, ['transaction']);
  assert.equal(engine.projection.getFact(fact.id)?.statement, 'Ports keep the boundary honest.');
  const second = engine.composeFact({ kind: 'fact', statement: 'Rolled back by the port.', confidence: 1,
    evidence: [], entities: [], episodeIds: [], tags: {} });
  assert.throws(() => engine.authorityTransaction(() => {
    engine.commitAuthority({ type: 'fact.recorded', fact: second });
    throw new Error('port rollback');
  }), /port rollback/);
  assert.equal(engine.projection.getFact(second.id), undefined);
});
