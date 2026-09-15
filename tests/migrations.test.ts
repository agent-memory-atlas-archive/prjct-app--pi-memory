import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate, prepareConnection, SCHEMA_VERSION } from '../src/storage/migrations.ts';

test('projection migrations are additive and reject a future schema', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'index.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1')");
  migrate(db);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
  assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM documents').get());
  assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM operational_checkpoints').get());
  db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
  assert.throws(() => migrate(db), /Unsupported memory projection schema/);
  db.close();
});

test('busy_timeout is set before schema statements', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-busy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'memory.sqlite'));
  prepareConnection(db);
  const timeout = db.prepare('PRAGMA busy_timeout').get() as { busy_timeout?: number } | undefined;
  assert.equal(Number(timeout?.busy_timeout ?? Object.values(timeout ?? {})[0]), 5000);
  migrate(db);
  db.close();
});
