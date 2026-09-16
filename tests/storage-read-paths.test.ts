import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Projection } from '../src/storage/projection.ts';

test('dense lookup is read-only when its vector collection does not exist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projection = new Projection(join(root, 'memory.sqlite'));
  t.after(() => projection.close());
  const before = Number(Object.values(projection.db.prepare('SELECT total_changes()').get() ?? {})[0]);
  assert.deepEqual(projection.vectorSearch('missing-model', 8, [1, 0, 0, 0, 0, 0, 0, 0], 10), []);
  const after = Number(Object.values(projection.db.prepare('SELECT total_changes()').get() ?? {})[0]);
  assert.equal(after, before);
  assert.equal(Number((projection.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'vec_[0-9a-f]*'").get() as { n: number }).n), 0);
});
