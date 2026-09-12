import { mkdir, readFile, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScopeKind, SourceDocument } from './contracts/documents.ts';
import { assertSourceDocument } from './contracts/documents.ts';
import { assertEvidence, evidenceStanding, type EvidenceRef } from './contracts/evidence.ts';
import type { MemoryEventPayload } from './contracts/events.ts';
import { assertTemporalFact, type Episode, type MemoryStanding, type TemporalFact } from './contracts/memory.ts';
import { hybridSearch, type HybridSearchResult, type MemoryQuery } from './retrieval/hybrid.ts';
import { redactSecrets } from './security/redact.ts';
import { MemoryJournal } from './storage/journal.ts';
import { Projection } from './storage/projection.ts';
import { createEmbeddingProvider, type EmbeddingConfig, type EmbeddingProvider } from './vector/providers.ts';
import { createVectorIndex, EmbeddingUnavailableError, type VectorIndex } from './vector/vector-index.ts';
import { componentPath, prjctHomeFor, resolveProject, sha256 } from './workspace/project-identity.ts';

export type MemoryEngineOptions = Readonly<{
  root: string;
  scopeId: string;
  sessionId: string;
  scopeKind?: ScopeKind;
  provider?: EmbeddingProvider;
  embedding?: EmbeddingConfig;
}>;

export type RecordFactInput = Omit<TemporalFact, 'id' | 'scopeId' | 'recordedAt' | 'standing'> & Readonly<{
  id?: string;
  standing?: MemoryStanding;
  recordedAt?: string;
}>;

export class MemoryEngine {
  readonly root: string;
  readonly scopeId: string;
  readonly scopeKind: ScopeKind;
  readonly journal: MemoryJournal;
  readonly projection: Projection;
  readonly vector: VectorIndex;

  constructor(options: MemoryEngineOptions) {
    this.root = options.root;
    this.scopeId = options.scopeId;
    this.scopeKind = options.scopeKind ?? (options.scopeId === 'shared' ? 'shared' : options.scopeId.startsWith('p_') ? 'project' : 'team');
    this.journal = new MemoryJournal(options.root, options.scopeId, options.sessionId);
    this.projection = new Projection(join(options.root, 'index.sqlite'));
    const provider = options.provider ?? createEmbeddingProvider(options.embedding ?? { cacheDir: join(prjctHomeFor(), 'shared', 'memory', 'models') });
    this.vector = createVectorIndex(this.projection, provider);
  }

  private async commit(payload: MemoryEventPayload): Promise<void> {
    const event = await this.journal.append(payload);
    this.projection.apply(event);
  }

  async index(document: SourceDocument, signal?: AbortSignal): Promise<{ chunks: number; embedded: number; dense: boolean }> {
    const sanitized = this.sanitizeDocument(document);
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
    const events = await this.journal.appendAll(sanitized.map(document => ({ type: 'document.upserted' as const, document })));
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
    await this.commit({ type: 'document.deleted', namespace, externalId, reason });
  }

  async recordEpisode(episode: Episode): Promise<void> {
    episode.evidence.forEach(assertEvidence);
    await this.commit({ type: 'episode.recorded', episode });
  }

  async recordFact(input: RecordFactInput, signal?: AbortSignal): Promise<{ fact: TemporalFact; dense: boolean }> {
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
    const fact = assertTemporalFact({ ...sanitized, id: input.id ?? `mem_${randomUUID()}`, scopeId: this.scopeId,
      recordedAt, standing: input.standing ?? evidenceStanding(sanitizedEvidence) });
    await this.commit({ type: 'fact.recorded', fact });
    const document = this.projection.documentByKey({ namespace: 'memory', externalId: fact.id })!;
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
    if (!this.projection.getFact(factId)) throw new Error(`Unknown memory ${factId}.`);
    await this.commit({ type: 'fact.resolved', factId, standing, rationale, ...(replacementId ? { replacementId } : {}) });
  }

  async feedback(factId: string, signal: 'used' | 'helpful' | 'wrong' | 'stale', query: string): Promise<void> {
    if (!this.projection.getFact(factId)) throw new Error(`Unknown memory ${factId}.`);
    await this.commit({ type: 'retrieval.feedback', factId, signal, queryHash: sha256(query) });
  }

  async recordGc(removed: readonly string[], retained: number): Promise<void> {
    await this.commit({ type: 'gc.compacted', removed, retained, generation: sha256(`${Date.now()}\u0000${removed.join('\u0000')}`).slice(0, 24) });
  }

  search(request: Omit<MemoryQuery, 'scopeId'>): Promise<HybridSearchResult> {
    return hybridSearch(this.projection, this.vector, { ...request, scopeId: this.scopeId });
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
      const events = await this.journal.readAll();
      const retired = this.vector;
      this.projection.close();
      const rebuilt = Projection.rebuild(join(this.root, 'index.sqlite'), events);
      Object.defineProperty(this, 'projection', { value: rebuilt });
      Object.defineProperty(this, 'vector', { value: createVectorIndex(rebuilt, retired.provider) });
      // dispose() only ever reaches the current index, so the replaced one has
      // to be released here or its provider is never shut down.
      await retired.dispose().catch(() => undefined);
      const reindexed = { count: 0 };
      for (const document of rebuilt.eachActiveDocument()) {
        await this.indexProjectionDocument(document, signal);
        reindexed.count += 1;
      }
      return { events: events.length, documents: reindexed.count };
    });
  }

  async dispose(): Promise<void> {
    await this.vector.dispose();
    this.projection.close();
  }

  static async forScope(kind: ScopeKind, scopeId: string, sessionId: string,
    options: { home?: string; provider?: EmbeddingProvider } = {}): Promise<MemoryEngine> {
    const home = prjctHomeFor(options.home);
    const root = componentPath(home, kind, scopeId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const config = await readConfig(root);
    return new MemoryEngine({ root, scopeId, scopeKind: kind, sessionId, ...(options.provider ? { provider: options.provider } : {}), embedding: config });
  }

  static async forProject(cwd: string, sessionId: string, options: { home?: string; provider?: EmbeddingProvider } = {}): Promise<MemoryEngine> {
    const project = await resolveProject(cwd);
    return MemoryEngine.forScope('project', project.projectId, sessionId, options);
  }

  static forTeam(teamId: string, sessionId: string, options: { home?: string; provider?: EmbeddingProvider } = {}): Promise<MemoryEngine> {
    return MemoryEngine.forScope('team', teamId, sessionId, options);
  }

  static forShared(sessionId: string, options: { home?: string; provider?: EmbeddingProvider } = {}): Promise<MemoryEngine> {
    return MemoryEngine.forScope('shared', 'shared', sessionId, options);
  }
}

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
    cacheDir: parsed.cacheDir ?? join(prjctHomeFor(), 'shared', 'memory', 'models') };
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
