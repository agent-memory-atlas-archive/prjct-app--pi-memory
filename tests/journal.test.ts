import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateEvent, MemoryJournal } from '../src/storage/journal.ts';

test('journal appends a hash-chained per-writer stream and replays it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  const first = await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  const second = await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'b', reason: 'test' }, '2026-01-01T00:00:01.000Z');
  assert.equal(second.previousHash, first.eventHash);
  assert.deepEqual((await journal.readAll()).map(event => event.id), [first.id, second.id]);
});

test('writer-local sequence orders events that share a wall-clock timestamp', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  const document = { namespace: 'docs', externalId: 'a', scopeId: 'p_test', scopeKind: 'project' as const,
    source: 'test', kind: 'document', text: 'newest', version: 'v2', contentHash: '0'.repeat(64),
    observedAt: '2026-01-01T00:00:00.000Z', trust: 'host' as const, metadata: {} };
  const upsert = await journal.append({ type: 'document.upserted', document }, '2026-01-01T00:00:00.000Z');
  const deleted = await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  assert.deepEqual((await journal.readAll()).map(event => event.id), [upsert.id, deleted.id]);
});

test('a malformed journal event fails validation instead of being projected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  const event = await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  assert.throws(() => validateEvent({ ...event, sequence: 0 } as unknown as Parameters<typeof validateEvent>[0]), /Invalid memory event/);
});

test('journal refuses a torn final event instead of silently losing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  await appendFile(join(root, 'events', '20260101', 'writer_0123456789abcdef.jsonl'), '{');
  await assert.rejects(journal.readAll(), /Torn memory journal line/);
});
