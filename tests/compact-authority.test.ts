import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { CompactAuthority, CompactCapacityError } from '../src/storage/compact-authority.ts';

const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'compact-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'memory.sqlite');
};
const footprint = async (path: string) => (await Promise.all([path, `${path}-wal`, `${path}-shm`].map(p => stat(p).then(info => info.size, () => 0)))).reduce((a, b) => a + b, 0);

test('compact authority creates one WAL/FULL project authority and roundtrips history without a journal file', async t => {
  const path = await fixture(t);
  const store = new CompactAuthority(path, 'p_test');
  const state = { records: { facts: [{ id: 'f1', text: 'Keep qualified evidence, not raw bodies.' }] }, history: [{ id: 'event1', hash: 'hash1' }] };
  assert.equal(store.read().revision, 0);
  assert.deepEqual(store.compareAndSwap(0, state), { status: 'committed', revision: 1 });
  assert.deepEqual(store.read().state, state);
  store.close();
  const reopened = new CompactAuthority(path, 'p_test');
  assert.deepEqual(reopened.read().state, state);
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(inspect.prepare('PRAGMA synchronous').get()!.synchronous, 2);
  assert.equal(inspect.prepare('PRAGMA page_size').get()!.page_size, 512);
  assert.equal(inspect.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum, 1);
  assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['compact_authority']);
  inspect.close(); reopened.close();
});

test('compact authority rejects foreign ownership and stale revisions without losing the winning state', async t => {
  const path = await fixture(t);
  const first = new CompactAuthority(path, 'p_test');
  const other = new CompactAuthority(path, 'p_test');
  assert.throws(() => new CompactAuthority(path, 'p_foreign'), /owner/iu);
  assert.equal(first.compareAndSwap(0, { fact: 'winning' }).status, 'committed');
  assert.deepEqual(other.compareAndSwap(0, { fact: 'stale' }), { status: 'stale', revision: 1 });
  assert.deepEqual(other.read().state, { fact: 'winning' });
  first.close(); other.close();
});

test('compact hot open and reads succeed under a competing writer; writes fail busy without waiting', async t => {
  const path = await fixture(t);
  const original = new CompactAuthority(path, 'p_test'); original.close();
  const competing = new DatabaseSync(path); competing.exec('BEGIN IMMEDIATE');
  const store = new CompactAuthority(path, 'p_test');
  const start = performance.now();
  assert.deepEqual(store.compareAndSwap(0, { fact: 'blocked' }), { status: 'busy' });
  assert.ok(performance.now() - start < 1000);
  assert.equal(store.read().revision, 0);
  competing.exec('ROLLBACK'); competing.close(); store.close();
});

test('pinned reader permits one bounded publication then backpressures rather than accumulating WAL', async t => {
  const path = await fixture(t);
  const store = new CompactAuthority(path, 'p_test');
  const reader = new DatabaseSync(path); reader.exec('BEGIN');
  reader.prepare('SELECT revision FROM compact_authority').get();
  assert.equal(store.compareAndSwap(0, { body: randomBytes(8500).toString('base64') }).status, 'committed');
  assert.deepEqual(store.compareAndSwap(1, { body: 'must wait' }), { status: 'busy' });
  assert.ok(await footprint(path) < 68857);
  assert.equal(reader.prepare('SELECT revision FROM compact_authority').get()!.revision, 0);
  reader.exec('ROLLBACK'); reader.close();
  assert.equal(store.compareAndSwap(1, { body: 'can publish' }).status, 'committed');
  store.close();
});

test('size admission refuses oversized state before publishing and repeated replacements stay within all phase bounds', async t => {
  const path = await fixture(t);
  const store = new CompactAuthority(path, 'p_test');
  for (const revision of Array.from({ length: 40 }, (_, i) => i)) {
    assert.equal(store.compareAndSwap(revision, { bytes: randomBytes(11000).toString('base64') }).status, 'committed');
    assert.ok(await footprint(path) < 68857, 'peak live including WAL/SHM');
    assert.equal(store.checkpoint(), 'checkpointed');
    assert.ok(await footprint(path) < 68857, 'quiescent including SHM');
  }
  const before = store.read();
  assert.throws(() => store.compareAndSwap(before.revision, { bytes: randomBytes(18000).toString('base64') }), CompactCapacityError);
  assert.deepEqual(store.read(), before);
  store.close(); assert.ok(await footprint(path) < 68857);
  const reopened = new CompactAuthority(path, 'p_test');
  assert.deepEqual(reopened.read(), before); assert.ok(await footprint(path) < 68857); reopened.close();
});

test('compact open will not silently convert a legacy indexed database', async t => {
  const path = await fixture(t);
  const old = new DatabaseSync(path); old.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);'); old.close();
  const before = (await stat(path)).size;
  assert.throws(() => new CompactAuthority(path, 'p_test'), /format/iu);
  assert.equal((await stat(path)).size, before);
});

test('invalid roots and corrupt or incompatible stored formats refuse without silently rewriting state', async t => {
  const path = await fixture(t);
  const store = new CompactAuthority(path, 'p_test');
  assert.throws(() => store.compareAndSwap(0, [] as never), /state root/iu);
  assert.throws(() => store.compareAndSwap(0, null as never), /state root/iu);
  assert.equal(store.read().revision, 0); store.close();
  const corrupt = new DatabaseSync(path); corrupt.exec("UPDATE compact_authority SET state=x'0001'"); corrupt.close();
  assert.throws(() => new CompactAuthority(path, 'p_test'), /corrupt/iu);
});

const startChild = async (path: string, mode: string) => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./compact-child.mts', import.meta.url).pathname, path, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = once(child, 'exit');
  const result = new Promise<string>(resolve => child.stdout.on('data', data => { if (String(data).includes('RESULT:')) resolve(String(data).split('RESULT:')[1]!.trim()); }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('compact child timeout')); }, 10000);
    child.stdout.on('data', data => { if (String(data).includes('READY')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`compact child exited ${code}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return { child, done, result };
};
for (const mode of ['pre-commit', 'post-commit', 'post-checkpoint']) {
  test(`compact SIGKILL ${mode} recovers the complete old or new authority`, async t => {
    const path = await fixture(t);
    const initial = new CompactAuthority(path, 'p_test'); initial.close();
    const writer = await startChild(path, mode);
    writer.child.kill('SIGKILL'); await writer.done;
    const reopened = new CompactAuthority(path, 'p_test');
    assert.equal(reopened.read().revision, mode === 'pre-commit' ? 0 : 1);
    assert.deepEqual(reopened.read().state, mode === 'pre-commit' ? {} : { facts: ['Alpha', 'Beta'], history: ['both committed'] });
    assert.ok(await footprint(path) < 68857); reopened.close();
  });
}

test('competing compact processes cannot both win the same revision', async t => {
  const path = await fixture(t);
  const initial = new CompactAuthority(path, 'p_test'); initial.close();
  const writers = await Promise.all(Array.from({ length: 4 }, (_, i) => startChild(path, `race-${i}`)));
  writers.forEach(writer => writer.child.stdin.write('GO\n'));
  const results = await Promise.all(writers.map(writer => writer.result.then(text => JSON.parse(text))));
  await Promise.all(writers.map(writer => writer.done));
  assert.equal(results.filter(row => row.status === 'committed').length, 1);
  assert.ok(results.every(row => ['committed', 'stale', 'busy'].includes(row.status)));
  const reopened = new CompactAuthority(path, 'p_test'); assert.equal(reopened.read().revision, 1); reopened.close();
});
