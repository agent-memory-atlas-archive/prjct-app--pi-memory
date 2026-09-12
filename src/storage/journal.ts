import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryEvent, MemoryEventPayload, UnsignedMemoryEvent } from '../contracts/events.ts';
import { sha256 } from '../workspace/project-identity.ts';

const MAX_EVENT_BYTES = 64 * 1024;

const dayKey = (date: Date): string =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;

const privateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe memory directory: ${path}`);
  }
};

export const validateEvent = (event: MemoryEvent, previous?: MemoryEvent): MemoryEvent => {
  if (event.schemaVersion !== 1 || !/^evt_[0-9a-f-]{36}$/.test(event.id)) throw new Error('Invalid memory event.');
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

  append(payload: MemoryEventPayload, recordedAt = new Date().toISOString()): Promise<MemoryEvent> {
    const operation = this.serial.then(async () => {
      const unsigned: UnsignedMemoryEvent = {
        schemaVersion: 1,
        id: `evt_${randomUUID()}`,
        scopeId: this.scopeId,
        writerId: this.writerId,
        sessionId: this.sessionId,
        sequence: this.sequence + 1,
        recordedAt,
        ...(this.previousHash ? { previousHash: this.previousHash } : {}),
        payload,
      };
      const event: MemoryEvent = { ...unsigned, eventHash: sha256(JSON.stringify(unsigned)) };
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) throw new Error('Memory event exceeds 64 KiB.');
      const target = this.path(new Date(recordedAt));
      await privateDirectory(join(this.root, 'events'));
      await privateDirectory(join(this.root, 'events', dayKey(new Date(recordedAt))));
      const handle = await open(target, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.sequence = event.sequence;
      this.previousHash = event.eventHash;
      return event;
    });
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  async readAll(): Promise<MemoryEvent[]> {
    const eventsRoot = join(this.root, 'events');
    const days = (await readdir(eventsRoot, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && /^\d{8}$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const paths = (await Promise.all(days.map(async day =>
      (await readdir(join(eventsRoot, day.name), { withFileTypes: true }))
        .filter(entry => entry.isFile() && /^writer_[0-9a-f]{16}\.jsonl$/.test(entry.name))
        .map(entry => join(eventsRoot, day.name, entry.name)))))
      .flat();
    const streams = await Promise.all(paths.map(async path => {
      const text = await readFile(path, 'utf8');
      const lines = text.split('\n');
      if (lines.at(-1) !== '') throw new Error(`Torn memory journal line: ${path}`);
      return lines.slice(0, -1).reduce<{ events: MemoryEvent[]; previous?: MemoryEvent }>((state, line) => {
        const event = validateEvent(JSON.parse(line) as MemoryEvent, state.previous);
        return { events: [...state.events, event], previous: event };
      }, { events: [] }).events;
    }));
    return streams.flat().sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  }
}
