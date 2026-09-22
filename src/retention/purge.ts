import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryEvent, MemoryEventPayload, UnsignedMemoryEvent } from '../contracts/events.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { validateEvent } from '../storage/journal.ts';

/**
 * Deleting a fact means deleting it.
 *
 * Retiring a fact used to mark it superseded and keep every byte: the row, its
 * document, chunks, full-text and vectors, and each event that ever mentioned
 * it. Measured on a real project, 160 of 230 stored facts were dead that way,
 * most of them raw tool output. A purge removes all of it. What is kept is the
 * purged id alone, so a replay or a rebuild never brings the content back from
 * a journal file another process was still writing when the purge ran.
 */

/** The payload with every trace of the purged facts removed; undefined when nothing is left. */
export const withoutPurged = (payload: MemoryEventPayload, purged: ReadonlySet<string>): MemoryEventPayload | undefined => {
  if (!purged.size) return payload;
  const memoryDocument = (namespace: string, externalId: string): boolean => namespace === 'memory' && purged.has(externalId);
  switch (payload.type) {
    case 'fact.recorded': {
      if (purged.has(payload.fact.id)) return undefined;
      const supersedes = payload.fact.supersedes?.filter(id => !purged.has(id));
      return supersedes && supersedes.length !== payload.fact.supersedes?.length
        ? { ...payload, fact: { ...payload.fact, supersedes } } : payload;
    }
    case 'fact.resolved':
      if (purged.has(payload.factId)) return undefined;
      if (payload.replacementId && purged.has(payload.replacementId)) {
        const { replacementId: _gone, ...rest } = payload;
        return rest;
      }
      return payload;
    case 'retrieval.feedback':
      return purged.has(payload.factId) ? undefined : payload;
    case 'document.upserted':
      return memoryDocument(payload.document.namespace, payload.document.externalId) ? undefined : payload;
    case 'document.deleted':
      return memoryDocument(payload.namespace, payload.externalId) ? undefined : payload;
    case 'curation.batch.commit': {
      const facts = payload.facts.filter(fact => !purged.has(fact.id));
      const documents = payload.documents.filter(document => !memoryDocument(document.namespace, document.externalId));
      const resolves = payload.resolves?.filter(item => !purged.has(item.factId));
      if (facts.length === payload.facts.length && documents.length === payload.documents.length
        && resolves?.length === payload.resolves?.length) return payload;
      return { ...payload, facts, documents, ...(resolves ? { resolves } : {}) };
    }
    default:
      return payload;
  }
};

/** Sign a writer stream again: same ids and payloads, a fresh sequence and hash chain. */
export const resign = (events: readonly MemoryEvent[]): MemoryEvent[] => {
  const chain: { sequence: number; previousHash?: string } = { sequence: 0 };
  return events.map(event => {
    const unsigned: UnsignedMemoryEvent = {
      schemaVersion: 1, id: event.id, scopeId: event.scopeId, writerId: event.writerId, sessionId: event.sessionId,
      sequence: chain.sequence + 1, recordedAt: event.recordedAt,
      ...(chain.previousHash ? { previousHash: chain.previousHash } : {}),
      payload: event.payload,
    };
    const signed: MemoryEvent = { ...unsigned, eventHash: sha256(JSON.stringify(unsigned)) };
    chain.sequence = signed.sequence;
    chain.previousHash = signed.eventHash;
    return signed;
  });
};

export type JournalPurge = Readonly<{
  /** Events removed from the journal files. */
  removed: readonly string[];
  /** Events whose payload was rewritten without the purged facts. */
  rewritten: number;
  /** Writer streams left for a later pass because another process may still be appending. */
  deferred: readonly string[];
  /** The new chain head of each rewritten writer, for a live journal that owns it. */
  heads: ReadonlyMap<string, Readonly<{ sequence: number; eventHash?: string }>>;
}>;

const DAY = /^\d{8}$/;
const WRITER = /^writer_[0-9a-f]{16}\.jsonl$/;

/**
 * Rewrite each writer's JSONL stream without the purged facts.
 *
 * The journal is hash-chained per writer, so a stream is re-signed whole. A
 * stream another process may still be appending to (touched within `quietMs`)
 * is left alone: re-chaining it under a live writer would break its next
 * append. The caller's own writer is safe to rewrite; its head is returned.
 */
export const purgeJournal = async (root: string, scopeId: string, purged: ReadonlySet<string>, options: Readonly<{
  ownWriter?: string; quietMs?: number; now?: number;
}> = {}): Promise<JournalPurge> => {
  const eventsRoot = join(root, 'events');
  const quietMs = options.quietMs ?? 10 * 60_000;
  const now = options.now ?? Date.now();
  const days = (await readdir(eventsRoot, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && DAY.test(entry.name)).map(entry => entry.name).sort();
  const streams = new Map<string, string[]>();
  for (const day of days) {
    for (const entry of await readdir(join(eventsRoot, day), { withFileTypes: true })) {
      if (!entry.isFile() || !WRITER.test(entry.name)) continue;
      streams.set(entry.name, [...streams.get(entry.name) ?? [], join(eventsRoot, day, entry.name)]);
    }
  }
  const removed: string[] = [];
  const deferred: string[] = [];
  const heads = new Map<string, { sequence: number; eventHash?: string }>();
  const rewritten = { count: 0 };
  for (const [name, paths] of streams) {
    const writerId = name.replace(/\.jsonl$/, '');
    const perFile = await Promise.all(paths.map(async path => {
      const text = await readFile(path, 'utf8');
      const lines = text.split('\n');
      if (lines.at(-1) !== '') throw new Error(`Torn memory journal line: ${path}`);
      return { path, events: lines.slice(0, -1).map(line => JSON.parse(line) as MemoryEvent) };
    }));
    const events = perFile.flatMap(file => file.events);
    const cleaned = events.map(event => ({ event, payload: withoutPurged(event.payload, purged) }));
    if (cleaned.every(({ event, payload }) => payload === event.payload)) continue;
    const touched = Math.max(...await Promise.all(paths.map(async path => (await lstat(path)).mtimeMs)));
    if (writerId !== options.ownWriter && now - touched < quietMs) { deferred.push(writerId); continue; }
    const kept = cleaned.flatMap(({ event, payload }) => {
      if (!payload) { removed.push(event.id); return []; }
      if (payload !== event.payload) rewritten.count += 1;
      return [{ ...event, payload }];
    });
    const signed = resign(kept);
    // Verify the new chain before anything touches the disk.
    signed.reduce<MemoryEvent | undefined>((previous, event) => validateEvent(event, previous, scopeId), undefined);
    const byPath = new Map(perFile.map(file => [file.path, new Set(file.events.map(event => event.id))]));
    for (const [path, ids] of byPath) {
      const lines = signed.filter(event => ids.has(event.id)).map(event => `${JSON.stringify(event)}\n`).join('');
      if (!lines) { await rm(path, { force: true }); continue; }
      const temporary = `${path}.purge-${process.pid}`;
      const handle = await open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(lines, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    }
    const head = signed.at(-1);
    heads.set(writerId, { sequence: head?.sequence ?? 0, ...(head ? { eventHash: head.eventHash } : {}) });
  }
  return { removed, rewritten: rewritten.count, deferred, heads };
};
