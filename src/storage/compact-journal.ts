import { randomUUID } from 'node:crypto';
import type { MemoryEvent, MemoryEventPayload, UnsignedMemoryEvent } from '../contracts/events.ts';
import { sha256 } from '../workspace/project-identity.ts';
import type { JournalPort } from './ports.ts';
import { validateEvent } from './journal.ts';
import type { CompactStore } from './compact-store.ts';

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Journal semantics backed by the compact authority itself. An append and its
 * domain reduction share one CAS; there is no JSONL sidecar and therefore no
 * window in which durable history and the readable projection disagree.
 */
export class CompactJournal implements JournalPort {
  readonly writerId: string;
  readonly sessionId: string;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: CompactStore, readonly scopeId: string, sessionId: string,
    writerId = `writer_${sha256(`${sessionId}\u0000${randomUUID()}`).slice(0, 16)}`) {
    this.sessionId = sessionId;
    this.writerId = writerId;
  }

  private previous(chain: readonly MemoryEvent[]): MemoryEvent | undefined {
    return [...chain].reverse().find(event => event.writerId === this.writerId);
  }

  private sign(payload: MemoryEventPayload, recordedAt: string, chain: readonly MemoryEvent[]): MemoryEvent {
    const previous = this.previous(chain);
    const unsigned: UnsignedMemoryEvent = {
      schemaVersion: 1,
      id: `evt_${randomUUID()}`,
      scopeId: this.scopeId,
      writerId: this.writerId,
      sessionId: this.sessionId,
      sequence: (previous?.sequence ?? 0) + 1,
      recordedAt,
      ...(previous ? { previousHash: previous.eventHash } : {}),
      payload,
    };
    return { ...unsigned, eventHash: sha256(JSON.stringify(unsigned)) };
  }

  appendAuthority(payload: MemoryEventPayload, recordedAt = new Date().toISOString()): MemoryEvent {
    if (!isTimestamp(recordedAt)) throw new Error(`Memory event recordedAt must be ISO-8601: ${recordedAt}`);
    return this.store.transaction(() => {
      const history = this.store.history();
      const event = this.sign(payload, recordedAt, history);
      validateEvent(event, this.previous(history), this.scopeId);
      this.store.applyEvent(event);
      return event;
    });
  }

  append(payload: MemoryEventPayload, recordedAt = new Date().toISOString()): Promise<MemoryEvent> {
    if (!isTimestamp(recordedAt)) return Promise.reject(new Error(`Memory event recordedAt must be ISO-8601: ${recordedAt}`));
    const operation = this.serial.then(() => this.appendAuthority(payload, recordedAt));
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  appendAll(payloads: readonly MemoryEventPayload[], recordedAt = new Date().toISOString()): Promise<MemoryEvent[]> {
    if (!payloads.length) return Promise.resolve([]);
    if (!isTimestamp(recordedAt)) return Promise.reject(new Error(`Memory event recordedAt must be ISO-8601: ${recordedAt}`));
    const operation = this.serial.then(() => this.store.transaction(() => {
      const events: MemoryEvent[] = [];
      for (const payload of payloads) {
        const history = [...this.store.history(), ...events];
        const event = this.sign(payload, recordedAt, history);
        validateEvent(event, this.previous(history), this.scopeId);
        this.store.applyEvent(event);
        events.push(event);
      }
      return events;
    }));
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  readAll(): Promise<MemoryEvent[]> { return Promise.resolve([...this.store.history()]); }
}
