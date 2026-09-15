import { isDeepStrictEqual } from 'node:util';
import type { SourceDocument } from '../contracts/documents.ts';
import { assertSourceDocument, documentKey } from '../contracts/documents.ts';
import { Projection, type VectorHit } from '../storage/projection.ts';
import type { ProjectionPort } from '../storage/ports.ts';
import { chunkDocument, type ChunkOptions } from './chunker.ts';
import type { EmbeddingProvider } from './providers.ts';

export type VectorQuery = Readonly<{
  text: string;
  limit?: number;
  signal?: AbortSignal;
}>;

export type VectorSearchHit = VectorHit & Readonly<{ text: string; namespace: string; source: string; externalId: string; uri?: string }>;

export class EmbeddingUnavailableError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(`Embedding provider unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'EmbeddingUnavailableError';
    this.cause = cause;
  }
}

export interface VectorIndex {
  readonly provider: EmbeddingProvider;
  upsert(document: SourceDocument, signal?: AbortSignal): Promise<{ chunks: number; embedded: number }>;
  upsertAll(documents: readonly SourceDocument[], signal?: AbortSignal): Promise<{ chunks: number; embedded: number }>;
  remove(namespace: string, externalId: string): void;
  search(query: VectorQuery): Promise<VectorSearchHit[]>;
  backfill(signal?: AbortSignal): Promise<number>;
  dispose(): Promise<void>;
}

export class SqliteVectorIndex implements VectorIndex {
  readonly provider: EmbeddingProvider;
  private readonly projection: ProjectionPort;
  private readonly chunkOptions: ChunkOptions;

  constructor(projection: ProjectionPort, provider: EmbeddingProvider, chunkOptions: ChunkOptions = {}) {
    this.projection = projection;
    this.provider = provider;
    this.chunkOptions = chunkOptions;
  }

  async upsert(document: SourceDocument, signal?: AbortSignal): Promise<{ chunks: number; embedded: number }> {
    assertSourceDocument(document);
    signal?.throwIfAborted();
    const existing = this.projection.documentByKey(document);
    if (!existing || !isDeepStrictEqual(existing, document)) this.projection.upsertDocument(document);
    const chunks = chunkDocument(document, this.chunkOptions);
    // The lexical index is committed before optional model work. If the local
    // model cannot be downloaded or a remote provider is unavailable, recall
    // remains useful and a later backfill can complete the dense leg.
    this.projection.replaceChunks(documentKey(document), chunks, document.title);
    const vectors = await this.provider.embed(chunks.map(chunk => chunk.text), { signal, inputType: 'passage' })
      .catch(error => { throw new EmbeddingUnavailableError(error); });
    if (vectors.length !== chunks.length) throw new EmbeddingUnavailableError('Provider returned an incomplete batch.');
    this.projection.storeVectors(chunks.map((chunk, index) => ({ chunkId: chunk.id, vector: vectors[index]! })), this.provider.model);
    return { chunks: chunks.length, embedded: vectors.length };
  }

  // Same work as upsert() but with one projection transaction for the whole run
  // and provider batches of 64, so a bulk ingest pays neither a transaction nor
  // a model round-trip per document.
  async upsertAll(documents: readonly SourceDocument[], signal?: AbortSignal): Promise<{ chunks: number; embedded: number }> {
    if (!documents.length) return { chunks: 0, embedded: 0 };
    for (const document of documents) assertSourceDocument(document);
    signal?.throwIfAborted();
    this.projection.transaction(() => {
      for (const document of documents) {
        const existing = this.projection.documentByKey(document);
        if (!existing || !isDeepStrictEqual(existing, document)) this.projection.upsertDocument(document);
      }
    });
    const chunks = documents.flatMap(document => chunkDocument(document, this.chunkOptions));
    const titles = new Map(documents.flatMap(document => document.title ? [[documentKey(document), document.title] as const] : []));
    this.projection.replaceChunksBatch(chunks, titles);
    const batches = Array.from({ length: Math.ceil(chunks.length / 64) }, (_, index) => chunks.slice(index * 64, (index + 1) * 64));
    const progress = { embedded: 0 };
    for (const batch of batches) {
      signal?.throwIfAborted();
      const vectors = await this.provider.embed(batch.map(chunk => chunk.text), { signal, inputType: 'passage' })
        .catch(error => { throw new EmbeddingUnavailableError(error); });
      if (vectors.length !== batch.length) throw new EmbeddingUnavailableError('Provider returned an incomplete batch.');
      this.projection.storeVectors(batch.map((chunk, index) => ({ chunkId: chunk.id, vector: vectors[index]! })), this.provider.model);
      progress.embedded += batch.length;
    }
    return { chunks: chunks.length, embedded: progress.embedded };
  }

  remove(namespace: string, externalId: string): void {
    this.projection.deleteDocument(namespace, externalId, new Date().toISOString());
  }

  async search(query: VectorQuery): Promise<VectorSearchHit[]> {
    const limit = Math.max(1, Math.min(1000, query.limit ?? 20));
    const [vector] = await this.provider.embed([query.text], { signal: query.signal, inputType: 'query' });
    if (!vector) return [];
    const hits = this.projection.vectorSearch(this.provider.model, vector.length, vector, limit);
    const chunks = new Map(this.projection.chunks(hits.map(hit => hit.chunkId)).map(chunk => [chunk.id, chunk]));
    return hits.flatMap(hit => {
      const chunk = chunks.get(hit.chunkId);
      return chunk ? [{ ...hit, text: chunk.text, namespace: chunk.namespace, source: chunk.document.source,
        externalId: chunk.document.externalId, ...(chunk.document.uri ? { uri: chunk.document.uri } : {}) }] : [];
    });
  }

  async backfill(signal?: AbortSignal): Promise<number> {
    const chunks = this.projection.unembeddedChunks(this.provider.model);
    const batches = Array.from({ length: Math.ceil(chunks.length / 64) }, (_, index) => chunks.slice(index * 64, (index + 1) * 64));
    for (const batch of batches) {
      signal?.throwIfAborted();
      const vectors = await this.provider.embed(batch.map(chunk => chunk.text), { signal, inputType: 'passage' })
        .catch(error => { throw new EmbeddingUnavailableError(error); });
      if (vectors.length !== batch.length) throw new EmbeddingUnavailableError('Provider returned an incomplete batch.');
      this.projection.storeVectors(batch.map((chunk, index) => ({ chunkId: chunk.id, vector: vectors[index]! })), this.provider.model);
    }
    return chunks.length;
  }

  async dispose(): Promise<void> {
    await this.provider.dispose?.();
  }
}

export const createVectorIndex = (projection: ProjectionPort, provider: EmbeddingProvider, options?: ChunkOptions): VectorIndex =>
  new SqliteVectorIndex(projection, provider, options);

class OwnedSqliteVectorIndex extends SqliteVectorIndex {
  private readonly ownedProjection: Projection;
  constructor(path: string, provider: EmbeddingProvider, options?: ChunkOptions) {
    const projection = new Projection(path);
    super(projection, provider, options);
    this.ownedProjection = projection;
  }
  override async dispose(): Promise<void> {
    try { await super.dispose(); } finally { this.ownedProjection.close(); }
  }
}

export const openVectorIndex = (options: Readonly<{ path: string; provider: EmbeddingProvider; chunking?: ChunkOptions }>): VectorIndex =>
  new OwnedSqliteVectorIndex(options.path, options.provider, options.chunking);
