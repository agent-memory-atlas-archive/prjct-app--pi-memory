import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryEvent, MemoryEventPayload, UnsignedMemoryEvent } from '../contracts/events.ts';
import { assertEventPayload } from '../contracts/events.ts';
import { sha256 } from '../workspace/project-identity.ts';

const MAX_EVENT_BYTES = 64 * 1024;
// SourceDocument already permits up to 1 MB of text. Do not silently preview
// artifacts to fit a fact-sized envelope; allow a bounded serialized document.
const MAX_DOCUMENT_EVENT_BYTES = 2 * 1024 * 1024;

const isTimestamp = (value: unknown): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().length > 0;

const dayKey = (date: Date): string =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;

const privateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe memory directory: ${path}`);
  }
};

export const validateEvent = (event: MemoryEvent, previous?: MemoryEvent, scopeId?: string): MemoryEvent => {
  if (event.schemaVersion !== 1 || !/^evt_[0-9a-f-]{36}$/.test(event.id)) throw new Error('Invalid memory event.');
  if (!/^writer_[0-9a-f]{16}$/.test(String(event.writerId))) throw new Error(`Invalid memory event writer: ${String(event.writerId)}`);
  if (typeof event.sessionId !== 'string' || !event.sessionId) throw new Error('Invalid memory event session.');
  if (event.sequence < 1 || !Number.isSafeInteger(event.sequence)) throw new Error('Invalid memory event.');
  if (!isTimestamp(event.recordedAt)) throw new Error(`Memory event recordedAt must be ISO-8601: ${String(event.recordedAt)}`);
  if (scopeId !== undefined && event.scopeId !== scopeId) throw new Error(`Memory event belongs to scope ${String(event.scopeId)}, not ${scopeId}.`);
  assertEventPayload(event.payload);
  const unsigned: UnsignedMemoryEvent = {
    schemaVersion: event.schemaVersion,
    id: event.id,
    scopeId: event.scopeId,
    writerId: event.writerId,
    sessionId: event.sessionId,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
    ...(event.previousHash ? { previousHash: event.previousHash } : {}),
    payload: event.payload,
  };
  if (sha256(JSON.stringify(unsigned)) !== event.eventHash) throw new Error(`Memory event hash mismatch: ${event.id}`);
  if (previous && (event.sequence !== previous.sequence + 1 || event.previousHash !== previous.eventHash)) throw new Error(`Broken memory journal chain: ${event.id}`);
  return event;
};

export class MemoryJournal {
  readonly root: string;
  readonly scopeId: string;
  readonly writerId: string;
  readonly sessionId: string;
  private sequence = 0;
  private previousHash: string | undefined;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(root: string, scopeId: string, sessionId: string, writerId = `writer_${sha256(`${sessionId}\u0000${randomUUID()}`).slice(0, 16)}`) {
    this.root = root;
    this.scopeId = scopeId;
    this.sessionId = sessionId;
    this.writerId = writerId;
  }

  private path(date: Date): string {
    return join(this.root, 'events', dayKey(date), `${this.writerId}.jsonl`);
  }

  private sign(payload: MemoryEventPayload, recordedAt: string, sequence: number, previousHash?: string): MemoryEvent {
    const unsigned: UnsignedMemoryEvent = {
      schemaVersion: 1,
      id: `evt_${randomUUID()}`,
      scopeId: this.scopeId,
      writerId: this.writerId,
      sessionId: this.sessionId,
      sequence,
      recordedAt,
      ...(previousHash ? { previousHash } : {}),
      payload,
    };
    return { ...unsigned, eventHash: sha256(JSON.stringify(unsigned)) };
  }

  // One write and one fsync for the whole run. fsync costs ~3.8 ms and dominates
  // everything else in the ingest path by two orders of magnitude, so a bulk
  // caller that pays it per event is paying for durability it does not need:
  // the batch is replayable, and a torn tail is re-ingested rather than lost.
  private async writeRun(events: readonly MemoryEvent[], recordedAt: string): Promise<void> {
    const lines = events.map(event => {
      const line = `${JSON.stringify(event)}\n`;
      const max = event.payload.type === 'document.upserted' ? MAX_DOCUMENT_EVENT_BYTES : MAX_EVENT_BYTES;
      if (Buffer.byteLength(line, 'utf8') > max) throw new Error(`Memory event exceeds ${max / 1024} KiB.`);
      return line;
    });
    const day = dayKey(new Date(recordedAt));
    await privateDirectory(join(this.root, 'events'));
    await privateDirectory(join(this.root, 'events', day));
    const handle = await open(this.path(new Date(recordedAt)),
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(lines.join(''), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  append(payload: MemoryEventPayload, recordedAt = new Date().toISOString()): Promise<MemoryEvent> {
    if (!isTimestamp(recordedAt)) return Promise.reject(new Error(`Memory event recordedAt must be ISO-8601: ${recordedAt}`));
    const operation = this.serial.then(async () => {
      const event = this.sign(payload, recordedAt, this.sequence + 1, this.previousHash);
      await this.writeRun([event], recordedAt);
      this.sequence = event.sequence;
      this.previousHash = event.eventHash;
      return event;
    });
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  appendAll(payloads: readonly MemoryEventPayload[], recordedAt = new Date().toISOString()): Promise<MemoryEvent[]> {
    if (!payloads.length) return Promise.resolve([]);
    if (!isTimestamp(recordedAt)) return Promise.reject(new Error(`Memory event recordedAt must be ISO-8601: ${recordedAt}`));
    const operation = this.serial.then(async () => {
      const chain = { sequence: this.sequence, previousHash: this.previousHash };
      const events = payloads.map(payload => {
        const event = this.sign(payload, recordedAt, chain.sequence + 1, chain.previousHash);
        chain.sequence = event.sequence;
        chain.previousHash = event.eventHash;
        return event;
      });
      await this.writeRun(events, recordedAt);
      this.sequence = chain.sequence;
      this.previousHash = chain.previousHash;
      return events;
    });
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  async readAll(): Promise<MemoryEvent[]> {
    const eventsRoot = join(this.root, 'events');
    const days = (await readdir(eventsRoot, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && /^\d{8}$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A writer that spans midnight gets one file per day. Grouping by writer and
    // reading its days in order verifies the hash chain ACROSS that boundary;
    // validating each file independently meant a whole day's file could be
    // removed without breaking any chain.
    const byWriter = new Map<string, string[]>();
    for (const day of days) {
      const entries = (await readdir(join(eventsRoot, day.name), { withFileTypes: true }))
        .filter(entry => entry.isFile() && /^writer_[0-9a-f]{16}\.jsonl$/.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const paths = byWriter.get(entry.name) ?? [];
        paths.push(join(eventsRoot, day.name, entry.name));
        byWriter.set(entry.name, paths);
      }
    }
    const streams = await Promise.all([...byWriter.values()].map(async paths => {
      const chain: { previous?: MemoryEvent } = {};
      const events: MemoryEvent[] = [];
      for (const path of paths) {
        const text = await readFile(path, 'utf8');
        const lines = text.split('\n');
        if (lines.at(-1) !== '') throw new Error(`Torn memory journal line: ${path}`);
        for (const line of lines.slice(0, -1)) {
          const event = validateEvent(JSON.parse(line) as MemoryEvent, chain.previous, this.scopeId);
          chain.previous = event;
          events.push(event);
        }
      }
      return events;
    }));
    return streams.flat().sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.writerId.localeCompare(b.writerId)
      || a.sequence - b.sequence || a.id.localeCompare(b.id));
  }
}
