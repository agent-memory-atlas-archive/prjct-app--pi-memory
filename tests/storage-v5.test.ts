import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SourceDocument } from '../src/contracts/documents.ts';
import { MemoryEngine } from '../src/engine.ts';
import { Projection } from '../src/storage/projection.ts';
import type { EmbeddingProvider } from '../src/vector/providers.ts';
import { sha256 } from '../src/workspace/project-identity.ts';

const document = (scopeId: string, text = 'The deployment authority uses an atomic verified database rewrite.'): SourceDocument => ({
  namespace: 'test', externalId: 'migration', scopeId, scopeKind: 'project', source: 'test', kind: 'document',
  title: 'Migration policy', text, version: sha256(text), contentHash: sha256(text), observedAt: new Date(0).toISOString(),
  trust: 'host', metadata: { owner: 'storage' },
});

class CountingProvider implements EmbeddingProvider {
  readonly model = 'counting-v1';
  readonly isLocal = true;
  calls = 0;
  texts = 0;
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    this.texts += texts.length;
    return texts.map((_text, row) => Array.from({ length: 8 }, (_value, column) => row === column ? 1 : 0));
  }
}

test('v4 indexed stores retain a verified private backup and atomically open as v5', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-v5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'memory.sqlite');
  const original = new Projection(path);
  original.claimOwner('p_storage');
  original.upsertDocument(document('p_storage'));
  const expectedChunks = original.chunkCount(document('p_storage'));
  original.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    DROP TABLE chunks_fts_vocab;
    DROP TABLE chunks_fts;
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED,title,text,metadata,
      tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
    INSERT INTO chunks_fts(chunk_id,title,text,metadata) SELECT id,coalesce(title,''),text,'' FROM chunks;
    UPDATE meta SET value='4' WHERE key='schema_version';
  `);
  legacy.close();

  const migrated = new Projection(path);
  assert.equal(migrated.chunkCount(document('p_storage')), expectedChunks);
  assert.ok(migrated.lexicalSearch('atomic verified rewrite', 10).length > 0);
  migrated.close();

  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, '5');
  assert.equal(Number(Object.values(db.prepare('PRAGMA page_size').get() ?? {})[0]), 4096);
  assert.equal(Number(Object.values(db.prepare('PRAGMA auto_vacuum').get() ?? {})[0]), 2);
  const ftsSql = (db.prepare("SELECT sql FROM sqlite_schema WHERE name='chunks_fts'").get() as { sql: string }).sql;
  assert.match(ftsSql, /contentless_delete=1/u);
  db.close();

  const backups = (await readdir(join(root, 'checkpoints'))).filter(name => /^pre-v5-.*\.sqlite$/u.test(name));
  assert.equal(backups.length, 1);
  const backupPath = join(root, 'checkpoints', backups[0]!);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal((backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, '4');
  assert.equal(Number((backup.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n), expectedChunks);
  backup.close();
});

test('unchanged source scans preserve lexical rows and vectors without another embedding call', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-noop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new CountingProvider();
  const engine = new MemoryEngine({ root, scopeId: 'p_noop', sessionId: 's1', provider, storage: 'indexed' });
  t.after(() => engine.dispose());
  const source = document('p_noop');
  const first = await engine.index(source);
  const inspect = new DatabaseSync(join(root, 'memory.sqlite'), { readOnly: true });
  const generation = (inspect.prepare("SELECT value FROM meta WHERE key='lexical_generation'").get() as { value: string }).value;
  const second = await engine.index({ ...source, observedAt: new Date(1_000).toISOString() });
  const after = (inspect.prepare("SELECT value FROM meta WHERE key='lexical_generation'").get() as { value: string }).value;
  inspect.close();
  assert.ok(first.embedded > 0);
  assert.equal(second.embedded, 0);
  assert.equal(provider.calls, 1);
  assert.equal(after, generation);
});
