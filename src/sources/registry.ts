import { assertSourceDocument, documentKey } from '../contracts/documents.ts';
import type { ScopeKind, SourceDocument } from '../contracts/documents.ts';
import { enqueueSnapshot } from '../curation/pipeline.ts';
import type { MemoryEngine } from '../engine.ts';
import type { Projection } from '../storage/projection.ts';
import { withSourceIdentity } from './identity.ts';
import { dueAdapters, type SyncDecision, type SyncPolicy } from './schedule.ts';

export type AdapterScope = Readonly<{ kind: ScopeKind; id: string }>;

export type SourceSnapshot = Readonly<{ documents: readonly SourceDocument[]; complete: boolean; gaps: readonly string[] }>;

export interface SourceAdapter {
  readonly id: string;
  /**
   * Which memory scope this adapter's documents belong to. Retrieval filters on
   * `document.scopeId`, so a team adapter synced into a project engine would
   * store rows that can never be returned. Declaring the scope lets the
   * registry route to the right engine and refuse the mismatch outright.
   */
  readonly scope: AdapterScope;
  scan(signal?: AbortSignal): Promise<readonly SourceDocument[]>;
  /** Optional authoritative snapshot. Only complete scans may retire documents previously owned by this adapter. */
  snapshot?(signal?: AbortSignal): Promise<SourceSnapshot>;
}

export type SourceSyncResult = Readonly<{
  adapter: string; scope: AdapterScope; discovered: number; indexed: number; unchanged: number;
  dense: number; removed: number; queued: number; gaps: readonly string[];
}>;

/** Supplies the engine that owns a given scope; sync never opens one itself. */
export type EngineResolver = (scope: AdapterScope) => Promise<MemoryEngine>;

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Source adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  list(): readonly string[] { return [...this.adapters.keys()].sort(); }
  get(id: string): SourceAdapter | undefined { return this.adapters.get(id); }

  /**
   * Prepared documents with adapter identity, no ingest. The low-level vector
   * API (`MemoryEngine.indexAll`) remains available for explicit callers.
   */
  async inspect(id: string, signal?: AbortSignal): Promise<SourceSnapshot> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown source adapter: ${id}`);
    const snapshot = await (adapter.snapshot ? adapter.snapshot(signal)
      : adapter.scan(signal).then(documents => ({ documents, complete: false, gaps: [] as const })));
    return { ...snapshot, documents: snapshot.documents.map(document => withSourceIdentity(adapter.id, document)) };
  }

  /**
   * Runs one adapter and records the outcome against `book`, the projection
   * that keeps the sync watermarks — normally the session's project scope, so
   * that one table answers "when did each source last run" regardless of which
   * scope the documents landed in. A failure is recorded too: an adapter that
   * throws every time should not look like one that has never run.
   */
  async sync(resolve: EngineResolver, id: string, signal?: AbortSignal, book?: Projection): Promise<SourceSyncResult> {
    try {
      const result = await this.run(resolve, id, signal);
      book?.recordSync(id, { discovered: result.discovered, indexed: result.indexed, ok: !result.gaps.length, ...(result.gaps.length ? { detail: result.gaps.join('; ') } : {}) });
      return result;
    } catch (error) {
      book?.recordSync(id, { discovered: 0, indexed: 0, ok: false, detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async run(resolve: EngineResolver, id: string, signal?: AbortSignal): Promise<SourceSyncResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown source adapter: ${id}`);
    const engine = await resolve(adapter.scope);
    if (engine.scopeId !== adapter.scope.id || engine.scopeKind !== adapter.scope.kind) {
      throw new Error(`Adapter ${id} targets ${adapter.scope.kind}/${adapter.scope.id} but the engine owns ${engine.scopeKind}/${engine.scopeId}.`);
    }
    return this.ingest(engine, adapter, signal).catch(error => {
      engine.projection.recordSync(id, { discovered: 0, indexed: 0, ok: false, detail: 'Source sync failed; retained index may be stale.' });
      throw error;
    });
  }

  private async ingest(engine: MemoryEngine, adapter: SourceAdapter, signal?: AbortSignal): Promise<SourceSyncResult> {
    const id = adapter.id;
    const snapshot = await this.inspect(id, signal);
    const documents = snapshot.documents;
    const foreign = documents.find(document => document.scopeId !== adapter.scope.id || document.scopeKind !== adapter.scope.kind);
    if (foreign) {
      throw new Error(`Adapter ${id} produced a ${foreign.scopeKind}/${foreign.scopeId} document outside its own scope.`);
    }
    documents.forEach(assertSourceDocument);
    const legacy = new Map([...engine.projection.eachDocumentHash()].map(row => [row.documentKey, row]));
    const collision = documents.find(document => {
      const key = documentKey(document);
      const owner = engine.curation.fingerprintOwner(key) ?? legacy.get(key)?.adapter;
      return owner !== undefined && owner !== id;
    });
    if (collision) throw new Error(`Adapter ${id} cannot overwrite another adapter's document.`);
    signal?.throwIfAborted();
    const queued = enqueueSnapshot(engine, adapter, snapshot, documents);
    engine.projection.recordSync(id, { discovered: documents.length, indexed: queued.changed, ok: !snapshot.gaps.length,
      ...(snapshot.gaps.length ? { detail: snapshot.gaps.join('; ') } : {}) });
    return { adapter: id, scope: adapter.scope, discovered: queued.discovered, indexed: queued.changed,
      unchanged: queued.unchanged, dense: 0, removed: queued.withdrawn, queued: queued.queued, gaps: snapshot.gaps };
  }

  async syncAll(resolve: EngineResolver, signal?: AbortSignal, book?: Projection): Promise<SourceSyncResult[]> {
    const results = [] as SourceSyncResult[];
    for (const id of this.list()) results.push(await this.sync(resolve, id, signal, book));
    return results;
  }

  /**
   * Runs only the adapters the watermark table says are due, and reports the
   * ones it skipped with the reason. One adapter failing does not stop the
   * others: its failure is recorded and the run continues.
   */
  async syncDue(resolve: EngineResolver, book: Projection, policy: SyncPolicy = {}, signal?: AbortSignal): Promise<{
    ran: SourceSyncResult[]; failed: readonly { adapter: string; error: string }[]; skipped: readonly SyncDecision[];
  }> {
    const decisions = dueAdapters(book, this.list(), policy);
    const ran = [] as SourceSyncResult[];
    const failed = [] as { adapter: string; error: string }[];
    for (const decision of decisions.filter(item => item.due)) {
      signal?.throwIfAborted();
      try { ran.push(await this.sync(resolve, decision.adapter, signal, book)); }
      catch (error) { failed.push({ adapter: decision.adapter, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { ran, failed, skipped: decisions.filter(item => !item.due) };
  }
}
