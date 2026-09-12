import { documentKey, type SourceDocument } from '../contracts/documents.ts';
import type { MemoryEngine } from '../engine.ts';

export interface SourceAdapter {
  readonly id: string;
  scan(signal?: AbortSignal): Promise<readonly SourceDocument[]>;
}

export type SourceSyncResult = Readonly<{ adapter: string; discovered: number; indexed: number; unchanged: number; dense: number }>;

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Source adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  list(): readonly string[] { return [...this.adapters.keys()].sort(); }

  async sync(engine: MemoryEngine, id: string, signal?: AbortSignal): Promise<SourceSyncResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown source adapter: ${id}`);
    const documents = await adapter.scan(signal);
    const current = new Map(engine.projection.activeDocuments().map(document => [documentKey(document), document.contentHash]));
    const changed = documents.filter(document => current.get(documentKey(document)) !== document.contentHash);
    const results = [] as Array<{ dense: boolean }>;
    for (const document of changed) results.push(await engine.index(document, signal));
    return { adapter: id, discovered: documents.length, indexed: changed.length,
      unchanged: documents.length - changed.length, dense: results.filter(item => item.dense).length };
  }

  async syncAll(engine: MemoryEngine, signal?: AbortSignal): Promise<SourceSyncResult[]> {
    const results = [] as SourceSyncResult[];
    for (const id of this.list()) results.push(await this.sync(engine, id, signal));
    return results;
  }
}
