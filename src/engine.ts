import { mkdir, readFile, open, rename, rm, stat } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScopeKind, SourceDocument } from './contracts/documents.ts';
import { assertSourceDocument, documentKey } from './contracts/documents.ts';
import { assertEvidence, evidenceStanding, type EvidenceRef } from './contracts/evidence.ts';
import type { MemoryEventPayload } from './contracts/events.ts';
import { assertTemporalFact, type Episode, type MemoryStanding, type TemporalFact } from './contracts/memory.ts';
import { collectLegs, hybridSearch, type HybridSearchResult, type MemoryQuery, type SearchLegs } from './retrieval/hybrid.ts';
import { redactSecrets } from './security/redact.ts';
import { CurationBlockError, isCuratedNamespace } from './curation/types.ts';
import { assertPublicationHold, jobIdFor, type CurationStore } from './curation/store.ts';
import { MemoryJournal } from './storage/journal.ts';
import { CompactJournal } from './storage/compact-journal.ts';
import { CompactCapacityError } from './storage/compact-authority.ts';
import { CompactStore } from './storage/compact-store.ts';
import { promoteCompactAuthority } from './storage/promotion.ts';
import { IndexedAuthority, type AuthorityPort, type CurationPort, type JournalPort, type ProjectionPort } from './storage/ports.ts';
import { Projection } from './storage/projection.ts';
import { createEmbeddingProvider, type EmbeddingConfig, type EmbeddingProvider } from './vector/providers.ts';
import { createVectorIndex, EmbeddingUnavailableError, type VectorIndex } from './vector/vector-index.ts';
import { MEMORY_DATABASE, assertExclusiveMemoryPath, assertProjectId, assertProjectLocalPath, componentPath, memoryDatabasePath, memoryHomeFor, resolveProject, sha256 } from './workspace/project-identity.ts';
import {
  MEMORY_REGISTRY_DIRECTORY,
  initializeMemoryProjectWith, resolveMemoryProject, type MemoryProjectBinding,
} from './workspace/memory-registry.ts';

export type MemoryEngineOptions = Readonly<{
  root: string;
  scopeId: string;
  sessionId: string;
  scopeKind?: ScopeKind;
  provider?: EmbeddingProvider;
  embedding?: EmbeddingConfig;
  /**
   * Where the default local encoder is cached. Shared across projects by
   * forScope(): per-project copies cost 130MB each for the same model.
   */
  modelCacheDir?: string;
  /** Auto keeps existing indexed stores unchanged and starts new stores compact. */
  storage?: 'auto' | 'compact' | 'indexed';
}>;

export type RecordFactInput = Omit<TemporalFact, 'id' | 'scopeId' | 'recordedAt' | 'standing'> & Readonly<{
  id?: string;
  standing?: MemoryStanding;
  recordedAt?: string;
}>;

export type PublicationBag = {
  facts: TemporalFact[];
  documents: SourceDocument[];
};

const publication = new AsyncLocalStorage<PublicationBag>();

export class MemoryEngine {
  readonly root: string;
  readonly scopeId: string;
  readonly scopeKind: ScopeKind;
  private journalValue!: JournalPort;
  private authorityValue!: AuthorityPort;
  private projectionValue!: ProjectionPort & Pick<Projection, 'db'>;
  private vectorValue!: VectorIndex;
  private curationValue!: CurationPort & Pick<CurationStore, 'db'>;
  private storageModeValue!: 'compact' | 'indexed';
  private compact: CompactStore | undefined;
  private readonly provider: EmbeddingProvider;

  /** Read-only access for passes that compare stored text with the same encoder
   * dense search already uses: consolidation must not load a second model. */
  get embeddings(): EmbeddingProvider { return this.provider; }
  private refreshing = false;

  get journal(): JournalPort { this.refreshStorageMode(); return this.journalValue; }
  private set journal(value: JournalPort) { this.journalValue = value; }
  get authority(): AuthorityPort { this.refreshStorageMode(); return this.authorityValue; }
  private set authority(value: AuthorityPort) { this.authorityValue = value; }
  get projection(): ProjectionPort & Pick<Projection, 'db'> { this.refreshStorageMode(); return this.projectionValue; }
  private set projection(value: ProjectionPort & Pick<Projection, 'db'>) { this.projectionValue = value; }
  get vector(): VectorIndex { this.refreshStorageMode(); return this.vectorValue; }
  private set vector(value: VectorIndex) { this.vectorValue = value; }
  get curation(): CurationPort & Pick<CurationStore, 'db'> { this.refreshStorageMode(); return this.curationValue; }
  private set curation(value: CurationPort & Pick<CurationStore, 'db'>) { this.curationValue = value; }
  get storageMode(): 'compact' | 'indexed' { this.refreshStorageMode(); return this.storageModeValue; }
  private set storageMode(value: 'compact' | 'indexed') { this.storageModeValue = value; }

  constructor(options: MemoryEngineOptions) {
    if ((options.scopeKind ?? 'project') !== 'project' || !options.scopeId.startsWith('p_')) {
      throw new Error('Memory opens only a project-owned database.');
    }
    this.root = options.root;
    this.scopeId = assertProjectId(options.scopeId);
    this.scopeKind = 'project';
    // A configured cacheDir must stay inside the project; the default is the shared cache.
    const defaultCache = (): string => options.modelCacheDir ?? assertProjectLocalPath(options.root, join(options.root, 'models'));
    const embedding = options.provider ? undefined : options.embedding
      ? { ...options.embedding, cacheDir: options.embedding.cacheDir ? assertProjectLocalPath(options.root, options.embedding.cacheDir) : defaultCache() }
      : { cacheDir: defaultCache() };
    const database = join(options.root, MEMORY_DATABASE);
    this.storageMode = resolveStorageMode(database, options.storage ?? 'auto');
    if (this.storageMode === 'compact') {
      const compact = new CompactStore(database, this.scopeId);
      this.compact = compact;
      this.projection = compact.projection;
      this.curation = compact.curation;
      this.authority = compact;
      this.journal = new CompactJournal(compact, this.scopeId, options.sessionId);
    } else {
      this.compact = undefined;
      const projection = new Projection(database);
      const curation = projection.attachCuration(database);
      projection.claimOwner(this.scopeId);
      this.projection = projection;
      this.curation = curation;
      this.authority = new IndexedAuthority(projection, curation);
      this.journal = new MemoryJournal(options.root, options.scopeId, options.sessionId);
    }
    this.provider = options.provider ?? createEmbeddingProvider(embedding!);
    this.vector = createVectorIndex(this.projection, this.provider);
  }

  private refreshStorageMode(): void {
    if (this.refreshing || !this.compact || this.compact.mode() === 0) return;
    this.refreshing = true;
    try {
      this.compact.close();
      this.installIndexed(new Projection(join(this.root, MEMORY_DATABASE)));
    } finally { this.refreshing = false; }
  }

  private installIndexed(projection: Projection): void {
    const curation = projection.attachCuration(projection.path);
    projection.claimOwner(this.scopeId);
    this.compact = undefined;
    this.storageMode = 'indexed';
    this.projection = projection;
    this.curation = curation;
    this.authority = new IndexedAuthority(projection, curation);
    this.journal = new MemoryJournal(this.root, this.scopeId, this.journal.sessionId);
    this.vector = createVectorIndex(projection, this.provider);
  }

  /** Empty stores can choose the indexed layout before their first durable
   * mutation. This is not a data migration: there is no event, job, vector or
   * checkpoint to move, and the compact files are removed only after close. */
  private promoteEmpty(): void {
    const compact = this.compact;
    if (!compact || !compact.isLogicallyEmpty()) {
      throw new Error('Non-empty compact memory requires atomic indexed promotion.');
    }
    compact.close();
    const database = join(this.root, MEMORY_DATABASE);
    for (const path of [database, `${database}-wal`, `${database}-shm`]) rmSync(path, { force: true });
    this.installIndexed(new Projection(database));
  }

  /** Stage additive indexed schema while mode 0 remains authoritative, then
   * populate every logical record and flip mode last in one SQLite commit. */
  private promoteCompact(): void {
    const compact = this.compact;
    if (!compact) return;
    const path = join(this.root, MEMORY_DATABASE);
    const projection = (() => {
      try { return promoteCompactAuthority(this.root, path, this.scopeId, compact); }
      catch (error) {
        if (compact.mode() === 1) return new Projection(path);
        throw error;
      }
    })();
    compact.close();
    this.installIndexed(projection);
  }

  private promoteForCapacity(): void {
    if (!this.compact) return;
    if (this.compact.isLogicallyEmpty()) this.promoteEmpty();
    else this.promoteCompact();
  }

  /** Select the indexed layout before mutation when a discovered source is
   * larger than the compact authority's bounded decode envelope. */
  prepareCapacity(discoveredBytes: number): void {
    if (!Number.isSafeInteger(discoveredBytes) || discoveredBytes < 0) throw new Error('Invalid discovered source size.');
    if (this.compact && discoveredBytes > 512 * 1024) this.promoteForCapacity();
  }

  authorityTransaction<T>(action: () => T): T {
    return this.authority.transaction(action);
  }

  commitAuthority(payload: MemoryEventPayload): void {
    const recordedAt = new Date().toISOString();
    if (this.journal.appendAuthority) {
      this.journal.appendAuthority(payload, recordedAt);
      return;
    }
    const unsigned = {
      schemaVersion: 1 as const, id: `evt_${randomUUID()}`, scopeId: this.scopeId, writerId: this.journal.writerId,
      sessionId: this.journal.sessionId, sequence: Math.max(1, Date.now() % 1_000_000_000), recordedAt, payload,
    };
    this.projection.apply({ ...unsigned, eventHash: sha256(JSON.stringify(unsigned)) });
  }

  private async commit(payload: MemoryEventPayload): Promise<void> {
    try {
      const event = await this.journal.append(payload);
      this.projection.apply(event);
    } catch (error) {
      if (!(error instanceof CompactCapacityError) || !this.compact) throw error;
      this.promoteCompact();
      const event = await this.journal.append(payload);
      this.projection.apply(event);
    }
  }

  async collectPublication<T>(fn: () => Promise<T>): Promise<{ result: T; bag: PublicationBag }> {
    const bag: PublicationBag = { facts: [], documents: [] };
    const result = await publication.run(bag, fn);
    return { result, bag };
  }

  composeFact(input: RecordFactInput): TemporalFact {
    input.evidence.forEach(assertEvidence);
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const sanitizedEvidence = input.evidence.map(evidence => {
      const excerpt = redactSecrets(evidence.excerpt);
      return excerpt === evidence.excerpt ? evidence : { ...evidence, excerpt, contentHash: sha256(excerpt) };
    });
    const sanitized = { ...input, statement: redactSecrets(input.statement),
      ...(input.subject ? { subject: redactSecrets(input.subject) } : {}),
      ...(input.predicate ? { predicate: redactSecrets(input.predicate) } : {}),
      ...(input.object ? { object: redactSecrets(input.object) } : {}), evidence: sanitizedEvidence,
      entities: input.entities.map(entity => ({ ...entity, name: redactSecrets(entity.name), aliases: entity.aliases.map(redactSecrets),
        ...(entity.summary ? { summary: redactSecrets(entity.summary) } : {}) })),
      tags: Object.fromEntries(Object.entries(input.tags).map(([key, value]) => [key, redactSecrets(value)])) };
    return assertTemporalFact({ ...sanitized, id: input.id ?? `mem_${randomUUID()}`, scopeId: this.scopeId,
      recordedAt, standing: input.standing ?? evidenceStanding(sanitizedEvidence) });
  }

  async projectPublication(facts: readonly TemporalFact[], documents: readonly SourceDocument[], signal?: AbortSignal): Promise<boolean> {
    const dense = { ok: true };
    if (facts.length) {
      try { this.projection.recordActivity({ inserts: facts.length }); }
      catch (error) {
        if (!(error instanceof CompactCapacityError) || !this.compact) throw error;
        this.promoteCompact();
        this.projection.recordActivity({ inserts: facts.length });
      }
    }
    for (const fact of facts) {
      const document = this.projection.documentByKey({ namespace: 'memory', externalId: fact.id });
      if (document) dense.ok = await this.indexProjectionDocument(document, signal) && dense.ok;
    }
    for (const document of documents) {
      try { await this.vector.upsert(document, signal); } catch (error) {
        if (!(error instanceof EmbeddingUnavailableError)) throw error;
        dense.ok = false;
      }
    }
    return dense.ok;
  }

  async index(document: SourceDocument, signal?: AbortSignal): Promise<{ chunks: number; embedded: number; dense: boolean }> {
    const internalPublication = publication.getStore() !== undefined;
    if (isCuratedNamespace(document.namespace) && !internalPublication) throw new Error('Curated namespaces are writable only by the curation publisher.');
    const owner = this.curation.fingerprintOwner(documentKey(document));
    if (owner !== undefined && !internalPublication) throw new Error(`Document is owned by source adapter ${owner}.`);
    const sanitized = this.sanitizeDocument(document);
    if (this.compact && JSON.stringify(sanitized).length > 12_000) this.promoteForCapacity();
    const bag = publication.getStore();
    if (bag) {
      bag.documents = [...bag.documents, sanitized];
      return { chunks: 1, embedded: 0, dense: true };
    }
    await this.commit({ type: 'document.upserted', document: sanitized });
    try {
      const result = await this.vector.upsert(sanitized, signal);
      return { ...result, dense: true };
    } catch (error) {
      if (!(error instanceof EmbeddingUnavailableError)) throw error;
      // vector.upsert commits deterministic chunks before model work; the dense
      // leg can be backfilled later without losing lexical availability.
      return { chunks: this.projection.chunkCount(sanitized), embedded: 0, dense: false };
    }
  }

  private sanitizeDocument(document: SourceDocument): SourceDocument {
    return assertSourceDocument({ ...document, text: redactSecrets(document.text),
      ...(document.title ? { title: redactSecrets(document.title) } : {}),
      ...(document.uri ? { uri: redactSecrets(document.uri) } : {}),
      metadata: Object.fromEntries(Object.entries(document.metadata).map(([key, value]) => [key, redactSecrets(value)])) });
  }

  // Bulk ingest. One fsync for the whole journal run instead of one per
  // document, one projection transaction, and provider batches of 64. Durability
  // is weaker than index() by exactly one batch: a crash mid-run can lose the
  // tail, which is re-ingested rather than reconstructed. Use index() when a
  // single write must survive on its own.
  async indexAll(documents: readonly SourceDocument[], signal?: AbortSignal): Promise<{ documents: number; chunks: number; embedded: number; dense: boolean }> {
    if (!documents.length) return { documents: 0, chunks: 0, embedded: 0, dense: true };
    const sanitized = documents.map(document => this.sanitizeDocument(document));
    if (this.compact && (sanitized.length >= 24 || JSON.stringify(sanitized).length > 12_000)) this.promoteForCapacity();
    const payloads = sanitized.map(document => ({ type: 'document.upserted' as const, document }));
    const events = await this.journal.appendAll(payloads).catch(async error => {
      if (!(error instanceof CompactCapacityError) || !this.compact) throw error;
      this.promoteCompact();
      return this.journal.appendAll(payloads);
    });
    this.projection.transaction(() => {
      for (const event of events) this.projection.apply(event);
    });
    try {
      const result = await this.vector.upsertAll(sanitized, signal);
      return { documents: sanitized.length, ...result, dense: true };
    } catch (error) {
      if (!(error instanceof EmbeddingUnavailableError)) throw error;
      return { documents: sanitized.length,
        chunks: sanitized.reduce((sum, document) => sum + this.projection.chunkCount(document), 0), embedded: 0, dense: false };
    }
  }

  async remove(namespace: string, externalId: string, reason: string): Promise<void> {
    assertPublicationHold();
    await this.commit({ type: 'document.deleted', namespace, externalId, reason: redactSecrets(reason) });
  }

  async recordEpisode(episode: Episode): Promise<void> {
    episode.evidence.forEach(assertEvidence);
    const sanitized = { ...episode, summary: redactSecrets(episode.summary), evidence: episode.evidence.map(evidence => {
      const excerpt = redactSecrets(evidence.excerpt);
      return excerpt === evidence.excerpt ? evidence : { ...evidence, excerpt, contentHash: sha256(excerpt) };
    }) };
    await this.commit({ type: 'episode.recorded', episode: sanitized });
  }

  async recordFact(input: RecordFactInput, signal?: AbortSignal,
    options: Readonly<{ dense?: boolean }> = {}): Promise<{ fact: TemporalFact; dense: boolean }> {
    const fact = this.composeFact(input);
    if (this.projection.getFact(fact.id)) throw new Error(`Memory ${fact.id} already exists; record a new fact instead.`);
    for (const id of fact.supersedes ?? []) {
      if (id === fact.id || !this.projection.getFact(id)) throw new Error(`Unknown superseded memory ${id}.`);
    }
    const bag = publication.getStore();
    if (bag) {
      bag.facts = [...bag.facts, fact];
      return { fact, dense: false };
    }
    await this.commit({ type: 'fact.recorded', fact });
    // Written memories are one of the signals that a source is worth re-reading.
    try { this.projection.recordActivity({ inserts: 1 }); }
    catch (error) {
      if (!(error instanceof CompactCapacityError) || !this.compact) throw error;
      this.promoteCompact();
      this.projection.recordActivity({ inserts: 1 });
    }
    const document = this.projection.documentByKey({ namespace: 'memory', externalId: fact.id })!;
    if (options.dense === false) return { fact, dense: false };
    const indexed = await this.indexProjectionDocument(document, signal);
    return { fact, dense: indexed };
  }

  private async indexProjectionDocument(document: SourceDocument, signal?: AbortSignal): Promise<boolean> {
    try { await this.vector.upsert(document, signal); return true; }
    catch (error) {
      if (error instanceof EmbeddingUnavailableError) return false;
      throw error;
    }
  }

  async resolveFact(factId: string, standing: MemoryStanding, rationale: string, replacementId?: string): Promise<void> {
    assertPublicationHold();
    const fact = this.projection.getFact(factId);
    if (!fact) throw new Error(`Unknown memory ${factId}.`);
    if (['superseded', 'contradicted'].includes(fact.standing) && !['superseded', 'contradicted'].includes(standing)) {
      throw new Error('A closed interval cannot be reopened without losing history; record a new fact instead.');
    }
    if (replacementId && (replacementId === factId || !this.projection.getFact(replacementId))) throw new Error('Replacement must be another existing memory.');
    // A superseded or contradicted fact is dead: delete it now instead of keeping
    // it forever with a flag. The journal catches up in compactJournal().
    if (standing === 'superseded' || standing === 'contradicted') {
      this.projection.purgeFacts([factId]);
      return;
    }
    await this.commit({ type: 'fact.resolved', factId, standing, rationale: redactSecrets(rationale), ...(replacementId ? { replacementId } : {}) });
  }

  async feedback(factId: string, signal: 'used' | 'helpful' | 'wrong' | 'stale', query: string): Promise<void> {
    const fact = this.projection.getFact(factId);
    if (!fact) throw new Error(`Unknown memory ${factId}.`);
    await this.commit({ type: 'retrieval.feedback', factId, signal, queryHash: sha256(query) });
    if (signal === 'wrong' || signal === 'stale') {
      const key = fact.tags.sourceDocumentKey ?? `memory:${Buffer.from(fact.id).toString('base64url')}`;
      this.curation.enqueue({
        id: jobIdFor(this.scopeId, 'review', key, `${fact.id}:${signal}`),
        scopeId: this.scopeId, adapter: fact.tags.sourceAdapter ?? 'legacy-journal', documentKey: key,
        action: 'review', inputRevision: `feedback:${fact.id}:${fact.tags.sourceRevision ?? fact.id}`,
        contentHash: fact.evidence[0]?.contentHash ?? sha256(fact.statement),
      });
    }
  }

  /**
   * Delete facts for good: the projection rows and everything hanging off them,
   * and every journal event that mentions them. Only their ids stay behind so
   * nothing brings them back. See retention/purge.ts.
   */
  async purgeFacts(ids: readonly string[]): Promise<{ facts: number; documents: number; evidence: number; events: number; deferred: number }> {
    const unique = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0))];
    const counts = unique.length ? this.projection.purgeFacts(unique) : { facts: 0, documents: 0, evidence: 0 };
    return { ...counts, ...await this.compactJournal() };
  }

  /**
   * Remove every purged fact from the journal files in one pass. Resolving a
   * fact dead only touches the projection, so a curation pass that retires
   * fifty facts rewrites the journal once, here, not fifty times.
   */
  async compactJournal(): Promise<{ events: number; deferred: number }> {
    const journal = this.journal;
    const purged = this.projection.purgedFacts();
    if (!(journal instanceof MemoryJournal) || !purged.size) return { events: 0, deferred: 0 };
    return withRebuildLock(this.root, async () => {
      const { purgeJournal } = await import('./retention/purge.ts');
      const rewritten = await journal.exclusive(
        writerId => purgeJournal(this.root, this.scopeId, purged, { ownWriter: writerId }),
        result => result.heads.get(journal.writerId));
      this.projection.purgeFacts([], rewritten.removed);
      return { events: rewritten.removed.length, deferred: rewritten.deferred.length };
    });
  }

  async recordGc(removed: readonly string[], retained: number): Promise<void> {
    await this.commit({ type: 'gc.compacted', removed, retained, generation: sha256(`${Date.now()}\u0000${removed.join('\u0000')}`).slice(0, 24) });
  }

  search(request: Omit<MemoryQuery, 'scopeId'>): Promise<HybridSearchResult> {
    return hybridSearch(this.projection, this.vector, { ...request, scopeId: this.scopeId });
  }

  /** Per-leg candidates for this scope, unfused. Federated search ranks these globally. */
  candidates(request: Omit<MemoryQuery, 'scopeId'>): Promise<SearchLegs> {
    return collectLegs(this.projection, this.vector, { ...request, scopeId: this.scopeId });
  }

  /** Loads the encoder with one tiny query; false when it is unavailable. */
  async warmEncoder(): Promise<boolean> {
    try { await this.provider.embed(['warm'], { inputType: 'query' }); return true; }
    catch { return false; }
  }

  /** Embeds chunks written without vectors. Returns 0 when no encoder is available. */
  async backfillVectors(signal?: AbortSignal): Promise<number> {
    try { return await this.vector.backfill(signal); }
    catch (error) {
      if (error instanceof EmbeddingUnavailableError) return 0;
      throw error;
    }
  }

  async replay(reindex = false, signal?: AbortSignal): Promise<{ events: number; documents: number }> {
    const events = await this.journal.readAll();
    const unapplied = events.filter(event => !this.projection.hasEvent(event.id));
    for (const event of unapplied) this.projection.apply(event);
    const reindexed = { count: 0 };
    if (reindex) {
      for (const document of this.projection.eachActiveDocument()) {
        await this.indexProjectionDocument(document, signal);
        reindexed.count += 1;
      }
    }
    return { events: unapplied.length, documents: reindexed.count };
  }

  async rebuild(signal?: AbortSignal): Promise<{ events: number; documents: number }> {
    return withRebuildLock(this.root, async () => {
      const { materializeSealedBatches } = await import('./curation/publish.ts');
      await materializeSealedBatches(this, signal);
      const events = await this.journal.readAll();
      const applied = { count: 0 };
      for (const event of events) {
        if (event.payload.type === 'curation.batch.commit') {
          const payload = event.payload;
          const batch = this.curation.batchRecord(payload.batchId);
          if (batch?.state === 'aborted') continue;
          const live = batch ? this.curation.fingerprint(batch.documentKey) : undefined;
          if (live && live.revision !== payload.sourceRevision) continue;
        }
        if (this.projection.apply(event)) applied.count += 1;
      }
      const reindexed = { count: 0 };
      for (const document of this.projection.eachActiveDocument()) {
        await this.indexProjectionDocument(document, signal);
        reindexed.count += 1;
      }
      return { events: events.length, documents: reindexed.count };
    });
  }

  async dispose(): Promise<void> {
    await this.vector.dispose();
    if (this.compact) this.compact.close();
    else {
      this.curation.close();
      this.projection.close();
    }
  }

  static async forScope(kind: ScopeKind, scopeId: string, sessionId: string,
    options: { home?: string; provider?: EmbeddingProvider; storage?: 'auto' | 'compact' | 'indexed' } = {}): Promise<MemoryEngine> {
    if (kind !== 'project') throw new Error('Memory opens only a project-owned database.');
    const home = memoryHomeFor(options.home);
    const root = componentPath(home, kind, assertProjectId(scopeId));
    await mkdir(root, { recursive: true, mode: 0o700 });
    assertExclusiveMemoryPath(home, scopeId, join(root, MEMORY_DATABASE));
    const config = await readConfig(root);
    return new MemoryEngine({ root, scopeId, scopeKind: 'project', sessionId, modelCacheDir: join(home, MEMORY_REGISTRY_DIRECTORY, 'models'),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.storage ? { storage: options.storage } : {}), embedding: config });
  }

  /** Compatibility API for explicit programmatic authorities. Pi uses forInitializedProject(). */
  static async forProject(cwd: string, sessionId: string,
    options: { home?: string; provider?: EmbeddingProvider; storage?: 'auto' | 'compact' | 'indexed' } = {}): Promise<MemoryEngine> {
    const project = await resolveProject(cwd, memoryHomeFor(options.home));
    return MemoryEngine.forScope('project', project.projectId, sessionId, options);
  }

  static async forInitializedProject(cwd: string, sessionId: string,
    options: { home?: string; provider?: EmbeddingProvider; storage?: 'auto' | 'compact' | 'indexed' } = {}): Promise<MemoryEngine> {
    const home = memoryHomeFor(options.home);
    const binding = await resolveMemoryProject(cwd, home);
    if (!binding) throw new Error('Memory is not initialized for this checkout. Run /memory init.');
    if (!existsSync(memoryDatabasePath(home, binding.projectId))) {
      throw new Error('Memory initialization is incomplete for this checkout. Run /memory init to repair it.');
    }
    return MemoryEngine.forScope('project', binding.projectId, sessionId, options);
  }

  static async initializeProject(cwd: string, sessionId: string,
    options: { home?: string; provider?: EmbeddingProvider; storage?: 'auto' | 'compact' | 'indexed' } = {}): Promise<Readonly<{
      engine: MemoryEngine; binding: MemoryProjectBinding; created: boolean;
    }>> {
    const home = memoryHomeFor(options.home);
    const opened: { engine?: MemoryEngine } = {};
    try {
      const initialized = await initializeMemoryProjectWith(cwd, home, async binding => {
        const engine = await MemoryEngine.forScope('project', binding.projectId, sessionId, options);
        opened.engine = engine;
        return engine;
      });
      return { engine: initialized.value, binding: initialized.binding, created: initialized.created };
    } catch (error) {
      await opened.engine?.dispose().catch(() => undefined);
      throw error;
    }
  }

  static forTeam(_teamId: string, _sessionId: string, _options: { home?: string; provider?: EmbeddingProvider } = {}): Promise<MemoryEngine> {
    return Promise.reject(new Error('Memory opens only a project-owned database.'));
  }

  static forShared(_sessionId: string, _options: { home?: string; provider?: EmbeddingProvider } = {}): Promise<MemoryEngine> {
    return Promise.reject(new Error('Memory opens only a project-owned database.'));
  }
}

const resolveStorageMode = (path: string, requested: 'auto' | 'compact' | 'indexed'): 'compact' | 'indexed' => {
  if (!existsSync(path)) return requested === 'indexed' ? 'indexed' : 'compact';
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view')").all() as { name: string }[])
      .map(row => row.name));
    const compact = names.has('compact_authority');
    const indexed = names.has('meta') || names.has('documents') || names.has('memory_owner');
    if (compact) {
      const marker = db.prepare('SELECT mode FROM compact_authority WHERE id=1').get() as { mode?: number } | undefined;
      if (marker?.mode === 1) {
        if (!indexed) throw new Error('Indexed authority marker has no indexed schema.');
        if (requested === 'compact') throw new Error('Existing indexed memory cannot be opened as compact.');
        return 'indexed';
      }
      if (marker?.mode !== 0) throw new Error('Unsupported memory authority mode.');
      if (requested === 'indexed') throw new Error('Existing compact memory cannot be opened as indexed without explicit promotion.');
      return 'compact';
    }
    if (indexed || names.size > 0) {
      if (requested === 'compact') throw new Error('Existing indexed memory cannot be opened as compact.');
      return 'indexed';
    }
    return requested === 'indexed' ? 'indexed' : 'compact';
  } finally { db.close(); }
};

const readConfig = async (root: string): Promise<EmbeddingConfig> => {
  const raw = await readFile(join(root, 'config.json'), 'utf8').catch(() => undefined);
  const parsed = raw ? JSON.parse(raw) as EmbeddingConfig : {};
  const provider = process.env.PI_MEMORY_EMBEDDINGS_PROVIDER === 'openai-compatible' ? 'openai-compatible' as const : parsed.provider;
  return { ...parsed, ...(provider ? { provider } : {}),
    model: process.env.PI_MEMORY_EMBEDDINGS_MODEL ?? parsed.model,
    baseUrl: process.env.PI_MEMORY_EMBEDDINGS_BASE_URL ?? parsed.baseUrl,
    // Deliberately NOT `?? parsed.apiKey`: a credential is read from the
    // environment only, so config.json can never become a place secrets live.
    apiKey: process.env.PI_MEMORY_EMBEDDINGS_API_KEY,
    ...(parsed.cacheDir ? { cacheDir: assertProjectLocalPath(root, resolve(root, parsed.cacheDir)) } : {}) };
};

const STALE_LOCK_MS = 10 * 60_000;

// Acquisition is atomic through O_EXCL. Reclaiming a stale lock is the delicate
// part: `stat` then `rm` then retry let two processes both delete the same stale
// file and both proceed, and the winner's fresh lock could be the one removed.
// Instead the reclaimer renames the stale file to a name only it knows — rename
// is atomic, so exactly one racer can succeed — and only that winner retries.
const withRebuildLock = async <T>(root: string, action: () => Promise<T>): Promise<T> => {
  const lockPath = join(root, 'rebuild.lock');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const acquire = async (reclaimed = false): Promise<void> => {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() })); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs < STALE_LOCK_MS || reclaimed) {
        throw new Error('A pi-memory rebuild is already running for this scope.');
      }
      const claim = `${lockPath}.stale-${token}`;
      await rename(lockPath, claim);
      await rm(claim, { force: true });
      return acquire(true);
    }
  };
  await acquire();
  try {
    return await action();
  } finally {
    // Release only if the lock on disk is still the one this call took: after a
    // stale reclaim another process may legitimately own the file by now.
    const held = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (held !== undefined && (JSON.parse(held) as { token?: string }).token === token) await rm(lockPath, { force: true });
  }
};

export const hostEvidence = (input: Readonly<{ excerpt: string; observedAt?: string; uri?: string; actorId?: string; sessionId?: string; toolCallId?: string }>): EvidenceRef => ({
  id: `ev_${randomUUID()}`, origin: 'host_observation', provenance: 'native_observation',
  contentHash: sha256(input.excerpt), excerpt: input.excerpt.slice(0, 8192), observedAt: input.observedAt ?? new Date().toISOString(),
  ...(input.uri ? { uri: input.uri } : {}), ...(input.actorId ? { actorId: input.actorId } : {}),
  ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
});
