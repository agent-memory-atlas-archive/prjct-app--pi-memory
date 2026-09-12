import type { ScopeKind, SourceDocument } from '../contracts/documents.ts';
import { documentKey } from '../contracts/documents.ts';
import type { MemoryEngine } from '../engine.ts';

export type AdapterScope = Readonly<{ kind: ScopeKind; id: string }>;

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
}

export type SourceSyncResult = Readonly<{
  adapter: string; scope: AdapterScope; discovered: number; indexed: number; unchanged: number; dense: number;
}>;

/** Supplies the engine that owns a given scope; sync never opens one itself. */
export type EngineResolver = (scope: AdapterScope) => Promise<MemoryEngine>;

const INGEST_BATCH = 250;

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Source adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  list(): readonly string[] { return [...this.adapters.keys()].sort(); }
  get(id: string): SourceAdapter | undefined { return this.adapters.get(id); }

  async sync(resolve: EngineResolver, id: string, signal?: AbortSignal): Promise<SourceSyncResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown source adapter: ${id}`);
    const engine = await resolve(adapter.scope);
    if (engine.scopeId !== adapter.scope.id || engine.scopeKind !== adapter.scope.kind) {
      throw new Error(`Adapter ${id} targets ${adapter.scope.kind}/${adapter.scope.id} but the engine owns ${engine.scopeKind}/${engine.scopeId}.`);
    }
    const documents = await adapter.scan(signal);
    const foreign = documents.find(document => document.scopeId !== adapter.scope.id || document.scopeKind !== adapter.scope.kind);
    if (foreign) {
      throw new Error(`Adapter ${id} produced a ${foreign.scopeKind}/${foreign.scopeId} document outside its own scope.`);
    }
    const current = new Map([...engine.projection.eachDocumentHash()].map(row => [row.documentKey, row.contentHash]));
    const changed = documents.filter(document => current.get(documentKey(document)) !== document.contentHash);
    // Batched: a first sync of a busy scope is thousands of documents, and one
    // fsync per document would make it minutes rather than seconds.
    const totals = { dense: 0 };
    for (const start of Array.from({ length: Math.ceil(changed.length / INGEST_BATCH) }, (_, index) => index * INGEST_BATCH)) {
      signal?.throwIfAborted();
      const batch = changed.slice(start, start + INGEST_BATCH);
      const result = await engine.indexAll(batch, signal);
      if (result.dense) totals.dense += batch.length;
    }
    return { adapter: id, scope: adapter.scope, discovered: documents.length, indexed: changed.length,
      unchanged: documents.length - changed.length, dense: totals.dense };
  }

  async syncAll(resolve: EngineResolver, signal?: AbortSignal): Promise<SourceSyncResult[]> {
    const results = [] as SourceSyncResult[];
    for (const id of this.list()) results.push(await this.sync(resolve, id, signal));
    return results;
  }
}
