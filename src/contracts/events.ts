import type { SourceDocument } from './documents.ts';
import type { Episode, MemoryStanding, TemporalFact } from './memory.ts';

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
