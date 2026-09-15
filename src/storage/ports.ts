import type { MemoryEvent, MemoryEventPayload } from '../contracts/events.ts';

/**
 * Typed boundary between orchestration and a storage implementation. The
 * indexed r17 layout and the compact layout both provide it; orchestration
 * therefore issues no raw transaction control and holds no driver handle.
 */
export type AuthorityPort = Readonly<{
  /** Re-entrant: nested calls join the outer group and commit exactly once. */
  transaction<T>(action: () => T): T;
  /** Explicit quiescent maintenance boundary. Never called mid-transaction. */
  checkpoint(): 'checkpointed' | 'busy';
}>;

export type JournalPort = {
  readonly writerId: string;
  readonly sessionId: string;
  append(payload: MemoryEventPayload, recordedAt?: string): Promise<MemoryEvent>;
  appendAll(payloads: readonly MemoryEventPayload[], recordedAt?: string): Promise<MemoryEvent[]>;
  readAll(): Promise<MemoryEvent[]>;
};

export type SnapshotPort = Readonly<{
  /** Consistent physical copy for an explicit, reversible checkpoint. */
  exportSnapshot(destination: string): void;
}>;

type IndexedProjection = SnapshotPort & Readonly<{
  adoptOuter(): void; releaseOuter(): void;
  beginImmediate(): void; commit(): void; rollback(): void;
  checkpointWal(): { status: 'checkpointed' | 'busy'; logFrames: number; checkpointedFrames: number };
}>;
type Nested = Readonly<{ adoptOuter(): void; releaseOuter(): void }>;

/** The r17 behaviour, unchanged: one physical transaction owned by the caller. */
export class IndexedAuthority implements AuthorityPort {
  private readonly open = { depth: 0 };
  constructor(private readonly projection: IndexedProjection, private readonly curation: Nested) {}

  transaction<T>(action: () => T): T {
    if (this.open.depth > 0) {
      this.open.depth += 1;
      try { return action(); } finally { this.open.depth -= 1; }
    }
    this.projection.adoptOuter();
    this.curation.adoptOuter();
    this.projection.beginImmediate();
    this.open.depth = 1;
    try {
      const result = action();
      this.projection.commit();
      return result;
    } catch (error) {
      try { this.projection.rollback(); } catch { /* the original error is the one that matters */ }
      throw error;
    } finally {
      this.open.depth = 0;
      this.projection.releaseOuter();
      this.curation.releaseOuter();
    }
  }

  checkpoint(): 'checkpointed' | 'busy' { return this.projection.checkpointWal().status; }
}
