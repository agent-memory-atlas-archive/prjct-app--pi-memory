import type { SourceDocument } from './documents.ts';
import { assertSourceDocument } from './documents.ts';
import { assertEvidence } from './evidence.ts';
import type { Episode, MemoryStanding, TemporalFact } from './memory.ts';
import { assertTemporalFact } from './memory.ts';

export type MemoryEventPayload =
  | Readonly<{ type: 'document.upserted'; document: SourceDocument }>
  | Readonly<{ type: 'document.deleted'; namespace: string; externalId: string; reason: string }>
  | Readonly<{ type: 'episode.recorded'; episode: Episode }>
  | Readonly<{ type: 'fact.recorded'; fact: TemporalFact }>
  | Readonly<{ type: 'fact.resolved'; factId: string; standing: MemoryStanding; rationale: string; replacementId?: string }>
  | Readonly<{ type: 'retrieval.feedback'; factId: string; signal: 'used' | 'helpful' | 'wrong' | 'stale'; queryHash: string }>
  | Readonly<{ type: 'gc.compacted'; removed: readonly string[]; retained: number; generation: string }>;

export type MemoryEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  scopeId: string;
  writerId: string;
  sessionId: string;
  sequence: number;
  recordedAt: string;
  previousHash?: string;
  eventHash: string;
  payload: MemoryEventPayload;
}>;

export type UnsignedMemoryEvent = Omit<MemoryEvent, 'eventHash'>;

const STANDINGS: readonly MemoryStanding[] = ['candidate', 'supported', 'needs_review', 'contradicted', 'superseded'];
const SIGNALS = ['used', 'helpful', 'wrong', 'stale'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 512): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const fields = (value: Record<string, unknown>, required: readonly string[], kind: string): void => {
  const missing = required.filter(name => !text(value[name], 100_000));
  if (missing.length) throw new Error(`Memory ${kind} payload is missing ${missing.join(', ')}.`);
};

// The event hash proves an entry has not been edited since it was written. It
// says nothing about whether the payload inside was well formed to begin with,
// so replay validates the payload against the same contracts the write path
// uses. Without this a self-consistent event with a malformed payload replayed
// straight into SQLite.
export const assertEventPayload = (value: unknown): MemoryEventPayload => {
  if (!isObject(value)) throw new Error('Memory event payload must be an object.');
  const payload = value as MemoryEventPayload;
  if (payload.type === 'document.upserted') {
    if (!isObject(payload.document)) throw new Error('Memory document.upserted payload requires a document.');
    fields(payload.document as unknown as Record<string, unknown>,
      ['namespace', 'externalId', 'scopeId', 'scopeKind', 'source', 'kind', 'text', 'version', 'contentHash', 'observedAt', 'trust'], 'document');
    if (!isObject((payload.document as unknown as Record<string, unknown>).metadata)) throw new Error('Memory document metadata must be an object.');
    assertSourceDocument(payload.document);
    return payload;
  }
  if (payload.type === 'document.deleted') {
    fields(payload as unknown as Record<string, unknown>, ['namespace', 'externalId', 'reason'], 'document.deleted');
    return payload;
  }
  if (payload.type === 'episode.recorded') {
    if (!isObject(payload.episode)) throw new Error('Memory episode.recorded payload requires an episode.');
    const episode = payload.episode as unknown as Record<string, unknown>;
    fields(episode, ['id', 'scopeId', 'kind', 'summary', 'observedAt', 'source'], 'episode');
    if (!Number.isFinite(Date.parse(String(episode.observedAt)))) throw new Error('Memory episode observedAt must be ISO-8601.');
    if (!Array.isArray(episode.evidence)) throw new Error('Memory episode evidence must be an array.');
    payload.episode.evidence.forEach(assertEvidence);
    return payload;
  }
  if (payload.type === 'fact.recorded') {
    if (!isObject(payload.fact)) throw new Error('Memory fact.recorded payload requires a fact.');
    const fact = payload.fact as unknown as Record<string, unknown>;
    fields(fact, ['id', 'scopeId', 'kind', 'statement', 'standing', 'recordedAt'], 'fact');
    if (typeof fact.confidence !== 'number' || !Number.isFinite(fact.confidence)) throw new Error('Memory fact confidence must be a number.');
    if (!Array.isArray(fact.evidence) || !Array.isArray(fact.entities) || !Array.isArray(fact.episodeIds)) {
      throw new Error('Memory fact evidence, entities and episodeIds must be arrays.');
    }
    if (!isObject(fact.tags)) throw new Error('Memory fact tags must be an object.');
    if (!STANDINGS.includes(payload.fact.standing)) throw new Error(`Unknown memory standing: ${String(fact.standing)}`);
    payload.fact.evidence.forEach(assertEvidence);
    assertTemporalFact(payload.fact);
    return payload;
  }
  if (payload.type === 'fact.resolved') {
    fields(payload as unknown as Record<string, unknown>, ['factId', 'rationale'], 'fact.resolved');
    if (!STANDINGS.includes(payload.standing)) throw new Error(`Unknown memory standing: ${String(payload.standing)}`);
    if (payload.replacementId !== undefined && !text(payload.replacementId)) throw new Error('Memory replacementId must be a string.');
    return payload;
  }
  if (payload.type === 'retrieval.feedback') {
    fields(payload as unknown as Record<string, unknown>, ['factId', 'queryHash'], 'retrieval.feedback');
    if (!SIGNALS.includes(payload.signal)) throw new Error(`Unknown retrieval signal: ${String(payload.signal)}`);
    return payload;
  }
  if (payload.type === 'gc.compacted') {
    if (!Array.isArray(payload.removed) || payload.removed.some(key => !text(key, 4096))) throw new Error('Memory gc.compacted removed must be an array of keys.');
    if (!Number.isSafeInteger(payload.retained) || payload.retained < 0) throw new Error('Memory gc.compacted retained must be a non-negative integer.');
    if (!text(payload.generation, 128)) throw new Error('Memory gc.compacted generation must be a string.');
    return payload;
  }
  throw new Error(`Unknown memory event payload type: ${String((value as { type?: unknown }).type)}`);
};
