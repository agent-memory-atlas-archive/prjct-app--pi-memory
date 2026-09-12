import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryJournal } from '../src/storage/journal.ts';

test('journal appends a hash-chained per-writer stream and replays it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  const first = await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  const second = await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'b', reason: 'test' }, '2026-01-01T00:00:01.000Z');
  assert.equal(second.previousHash, first.eventHash);
  assert.deepEqual((await journal.readAll()).map(event => event.id), [first.id, second.id]);
});

test('journal refuses a torn final event instead of silently losing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  await appendFile(join(root, 'events', '20260101', 'writer_0123456789abcdef.jsonl'), '{');
  await assert.rejects(journal.readAll(), /Torn memory journal line/);
});
