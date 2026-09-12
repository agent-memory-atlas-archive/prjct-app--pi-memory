import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
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

// The tie-break that matters is between writers: within one writer the file is
// already in order and a stable sort preserves it, so a same-writer test passes
// even with no tie-break at all. Here two writers share a timestamp and the
// journal is read back from freshly shuffled directory state each time.
test('two writers sharing a timestamp replay in one deterministic order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = '2026-01-01T00:00:00.000Z';
  const alpha = new MemoryJournal(root, 'p_test', 'session-a', 'writer_aaaaaaaaaaaaaaaa');
  const omega = new MemoryJournal(root, 'p_test', 'session-b', 'writer_ffffffffffffffff');
  const note = (journal: MemoryJournal, id: string) =>
    journal.append({ type: 'document.deleted', namespace: 'docs', externalId: id, reason: 'test' }, at);

  // Interleave the writes so neither writer's events are contiguous on disk.
  const written = [await note(omega, 'o1'), await note(alpha, 'a1'), await note(omega, 'o2'), await note(alpha, 'a2')];
  const expected = [...written].sort((a, b) => a.writerId.localeCompare(b.writerId) || a.sequence - b.sequence).map(event => event.id);

  const reader = new MemoryJournal(root, 'p_test', 'reader');
  const runs = await Promise.all(Array.from({ length: 5 }, () => reader.readAll()));
  for (const run of runs) assert.deepEqual(run.map(event => event.id), expected);
  // writer_aaaa... sorts before writer_ffff..., so alpha's stream comes first
  // even though omega wrote first.
  assert.deepEqual(expected, [written[1]!.id, written[3]!.id, written[0]!.id, written[2]!.id]);
});

test('replay rejects an event whose payload is malformed but whose hash is intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  // Re-sign a bad payload so the hash chain is perfectly valid: only a payload
  // contract check can catch this.
  const forged = { schemaVersion: 1, id: `evt_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, scopeId: 'p_test',
    writerId: 'writer_0123456789abcdef', sessionId: 'session-one', sequence: 2, recordedAt: '2026-01-01T00:00:01.000Z',
    payload: { type: 'fact.recorded', fact: { id: 'not-a-memory-id' } } };
  const eventHash = createHash('sha256').update(JSON.stringify(forged)).digest('hex');
  await appendFile(join(root, 'events', '20260101', 'writer_0123456789abcdef.jsonl'),
    `${JSON.stringify({ ...forged, eventHash })}\n`);
  await assert.rejects(journal.readAll(), /Memory fact payload is missing|Invalid memory id/);
});

test('replay rejects an event recorded for a different scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const foreign = new MemoryJournal(root, 'p_other', 'session-one', 'writer_0123456789abcdef');
  await foreign.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  const local = new MemoryJournal(root, 'p_test', 'session-two');
  await assert.rejects(local.readAll(), /belongs to scope p_other/);
});

test('journal refuses a non-timestamp recordedAt instead of writing an unreadable directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  await assert.rejects(
    journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, 'not-a-date'),
    /recordedAt must be ISO-8601/);
});

test('journal refuses a torn final event instead of silently losing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MemoryJournal(root, 'p_test', 'session-one', 'writer_0123456789abcdef');
  await journal.append({ type: 'document.deleted', namespace: 'docs', externalId: 'a', reason: 'test' }, '2026-01-01T00:00:00.000Z');
  await appendFile(join(root, 'events', '20260101', 'writer_0123456789abcdef.jsonl'), '{');
  await assert.rejects(journal.readAll(), /Torn memory journal line/);
});
