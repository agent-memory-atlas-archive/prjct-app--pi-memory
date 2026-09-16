import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { chunkDocument } from '../vector/chunker.ts';
import { rankLexically, words } from '../retrieval/lexical.ts';
import { documentKey } from '../contracts/documents.ts';
import type { DocumentChunk, SourceDocument } from '../contracts/documents.ts';
import type { EvidenceRef } from '../contracts/evidence.ts';
import type { MemoryEvent } from '../contracts/events.ts';
import type { Entity, Episode, MemoryStanding, TemporalFact } from '../contracts/memory.ts';
import { jobIdFor, sanitizeDetail, stillHeld } from '../curation/store.ts';
import type { CurationJob, CurationStats, JobStatus, SourceIdentity, Spend } from '../curation/types.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { CompactAuthority, CompactCapacityError, type CompactState } from './compact-authority.ts';
import type { StoredFact, SyncActivity, SyncRun } from './projection.ts';

export class CompactConflictError extends Error {}
export class CompactBusyError extends Error {}

type FactRecord = TemporalFact & { standing: MemoryStanding; replacementId?: string; expiredAt?: string; invalidAt?: string };
type Usefulness = { used: number; helpful: number; wrong: number; stale: number; lastSignalAt: number };
type Link = { from: string; to: string; relation: string };
type Draft = { offset: number; factIds: string[]; qualifications: string[]; summary: string };
type Batch = { id: string; jobId: string; documentKey: string; sourceRevision: string; contentHash: string;
  topicExpected: number; payloads: unknown; state: string; createdAt: number };
type Fingerprint = SourceIdentity & { withdrawnAt?: number; updatedAt: number };
type Topic = { id: string; scopeId: string; title: string; summary: string; revision: number; summaryHash: string; factIds: string[]; updatedAt: number };

export type CompactDomainState = {
  version: 1;
  history: MemoryEvent[];
  applied: Record<string, string>;
  documents: Record<string, { document: SourceDocument; deletedAt: number | null }>;
  chunks: Record<string, DocumentChunk>;
  vectors: Record<string, { model: string; dims: number; values: number[] }>;
  facts: Record<string, FactRecord>;
  evidence: Record<string, EvidenceRef>;
  entities: Record<string, Entity>;
  episodes: Record<string, Omit<Episode, 'evidence'> & { evidenceIds: string[] }>;
  factEvidence: Record<string, string[]>;
  factEntities: Record<string, string[]>;
  factEpisodes: Record<string, string[]>;
  links: Link[];
  usefulness: Record<string, Usefulness>;
  activity: SyncActivity;
  sync: Record<string, SyncRun>;
  checkpoints: Record<string, { body: string; updatedAt: number }>;
  curation: {
    fingerprints: Record<string, Fingerprint>;
    jobs: Record<string, CurationJob>;
    watermarks: Record<string, { revision: string; outcome: string; at: number }>;
    topics: Record<string, Topic>;
    batches: Record<string, Batch>;
    coverage: Record<string, { offset: number; total: number; updatedAt: number }>;
    drafts: Record<string, Draft>;
    dependencies: Record<string, { factId: string; documentKey: string; adapter: string; revision: string }>;
    spend: Record<string, Spend>;
  };
};

const TERMINAL: readonly JobStatus[] = ['published', 'no_change', 'discarded'];
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
const defined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
type State = CompactDomainState;

const emptyState = (): State => ({
  version: 1, history: [], applied: {}, documents: {}, chunks: {}, vectors: {}, facts: {}, evidence: {}, entities: {},
  episodes: {}, factEvidence: {}, factEntities: {}, factEpisodes: {}, links: [], usefulness: {},
  activity: { turns: 0, tokens: 0, inserts: 0, updatedAt: 0 }, sync: {}, checkpoints: {},
  curation: { fingerprints: {}, jobs: {}, watermarks: {}, topics: {}, batches: {}, coverage: {}, drafts: {}, dependencies: {}, spend: {} },
});
const jobView = (job: CurationJob): CurationJob => defined({ ...job }) as CurationJob;
const tokenSequencePresent = (text: string, token: string): boolean => {
  const haystack = words(text);
  const needle = words(token);
  return needle.length > 0 && haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
};

/**
 * Compact domain adapters over one CompactAuthority snapshot. Pure state
 * transitions; no SQL emulation and no second persistent store. History and
 * domain application commit in a single outer compare-and-swap, so a group of
 * nested operations is one authority revision or none.
 *
 * Retrieval, engine routing and indexed promotion are deliberately NOT here:
 * this backend is not yet wired into MemoryEngine.
 */
export class CompactStore {
  private readonly authority: CompactAuthority;
  private readonly draft: { state?: State; depth: number; base: number } = { depth: 0, base: 0 };
  private cached: { revision: number; state: State } | undefined;
  private capacity = false;
  readonly projection: CompactProjection;
  readonly curation: CompactCuration;

  constructor(readonly path: string, readonly projectId: string) {
    this.authority = new CompactAuthority(path, projectId);
    this.projection = new CompactProjection(this);
    this.curation = new CompactCuration(this);
  }

  /** Read view: the open draft inside a transaction, else the committed snapshot. */
  state(): State {
    if (this.draft.state) return this.draft.state;
    const snapshot = this.authority.read();
    if (this.cached?.revision !== snapshot.revision) {
      const decoded = snapshot.state.version === 1 ? structuredClone(snapshot.state) as unknown as State : emptyState();
      this.cached = { revision: snapshot.revision, state: decoded };
    }
    return this.cached.state;
  }

  revision(): number { return this.authority.read().revision; }
  mode(): 0 | 1 { return this.authority.mode(); }
  promotionRequired(): boolean { return this.capacity; }
  isLogicallyEmpty(): boolean { return JSON.stringify(this.state()) === JSON.stringify(emptyState()); }
  checkpoint(): 'checkpointed' | 'busy' {
    if (this.draft.state) throw new Error('Cannot checkpoint inside an authority transaction.');
    return this.authority.checkpoint();
  }
  publicationPaused(): boolean { return this.authority.publicationPaused(); }
  exportSnapshot(destination: string): void { this.authority.exportSnapshot(destination); }
  close(): void { this.authority.close(); }

  transaction<T>(action: () => T): T {
    if (this.draft.state) {
      this.draft.depth += 1;
      try { return action(); } finally { this.draft.depth -= 1; }
    }
    const snapshot = this.authority.read();
    this.draft.state = structuredClone(snapshot.state.version === 1 ? snapshot.state as unknown as State : emptyState());
    this.draft.base = snapshot.revision;
    this.draft.depth = 1;
    try {
      const result = action();
      const next = this.draft.state;
      this.draft.state = undefined; this.draft.depth = 0;
      const written = this.authority.compareAndSwap(this.draft.base, next as unknown as CompactState);
      if (written.status === 'busy') throw new CompactBusyError('Compact authority is busy; retry at a later boundary.');
      if (written.status === 'stale') throw new CompactConflictError('Compact authority advanced; retry against the new revision.');
      this.cached = { revision: written.revision, state: next };
      return result;
    } catch (error) {
      this.draft.state = undefined; this.draft.depth = 0;
      if (error instanceof CompactCapacityError) this.capacity = true;
      throw error;
    }
  }

  history(): readonly MemoryEvent[] { return this.state().history; }
  promotionState(): CompactDomainState { return structuredClone(this.state()); }
  withPromotionLock<T>(action: (state: CompactDomainState, db: DatabaseSync) => T): T {
    if (this.draft.state) throw new Error('Cannot promote inside an authority transaction.');
    return this.authority.withPromotionLock((snapshot, db) => action(
      structuredClone(snapshot.state.version === 1 ? snapshot.state as unknown as State : emptyState()), db));
  }

  applyEvent(event: MemoryEvent): boolean {
    if (this.state().applied[event.id]) return false;
    return this.transaction(() => {
      const state = this.draft.state!;
      if (state.applied[event.id]) return false;
      if (!state.history.some(item => item.id === event.id)) state.history = [...state.history, event];
      applyToState(state, event);
      state.applied[event.id] = event.eventHash;
      return true;
    });
  }

  async replay(): Promise<{ events: number; documents: number }> {
    const pending = this.state().history.filter(event => !this.state().applied[event.id]);
    if (!pending.length) return { events: 0, documents: 0 };
    this.transaction(() => {
      const state = this.draft.state!;
      for (const event of pending) { applyToState(state, event); state.applied[event.id] = event.eventHash; }
    });
    return { events: pending.length, documents: 0 };
  }

  /** Canonical SQLite alone recovers: history and curation live in the same snapshot. */
  async rebuild(): Promise<{ events: number; documents: number }> {
    const events = [...this.state().history];
    this.transaction(() => {
      const state = this.draft.state!;
      for (const event of events) {
        if (event.payload.type === 'curation.batch.commit') {
          const payload = event.payload;
          const batch = state.curation.batches[payload.batchId];
          if (batch?.state === 'aborted') continue;
          const live = batch ? state.curation.fingerprints[batch.documentKey] : undefined;
          if (live && !live.withdrawnAt && live.revision !== payload.sourceRevision) continue;
        }
        if (state.applied[event.id]) continue;
        applyToState(state, event);
        state.applied[event.id] = event.eventHash;
      }
    });
    return { events: events.length, documents: this.projection.activeDocuments({ limit: 10_000 }).length };
  }
}

// ---------------------------------------------------------------- reducers

const dropChunk = (state: State, id: string): void => { delete state.chunks[id]; delete state.vectors[id]; };
const replaceChunks = (state: State, key: string, document: SourceDocument): void => {
  for (const id of Object.keys(state.chunks)) if (state.chunks[id]!.documentKey === key) dropChunk(state, id);
  if (!document.text.trim()) return;
  for (const chunk of chunkDocument(document)) state.chunks[chunk.id] = chunk;
};
const upsertDocument = (state: State, document: SourceDocument): void => {
  const key = documentKey(document);
  const generated = document.text.trim() ? chunkDocument(document) : [];
  const current = Object.values(state.chunks).filter(chunk => chunk.documentKey === key).sort((left, right) => left.ordinal - right.ordinal);
  const sameChunks = current.length === generated.length && current.every((chunk, index) => chunk.id === generated[index]?.id
    && JSON.stringify(chunk.metadata) === JSON.stringify(generated[index]?.metadata ?? {}));
  state.documents[key] = { document, deletedAt: null };
  if (!sameChunks) replaceChunks(state, key, document);
};
const deleteDocumentKey = (state: State, key: string, at: string): void => {
  for (const id of Object.keys(state.chunks)) if (state.chunks[id]!.documentKey === key) dropChunk(state, id);
  const existing = state.documents[key];
  if (existing) existing.deletedAt = Date.parse(at);
};
const insertEvidence = (state: State, evidence: EvidenceRef): void => {
  if (!state.evidence[evidence.id]) state.evidence[evidence.id] = evidence;
};
const link = (state: State, from: string, to: string, relation: string): void => {
  if (!state.links.some(item => item.from === from && item.to === to && item.relation === relation)) {
    state.links = [...state.links, { from, to, relation }];
  }
};
const resolveFactState = (state: State, id: string, standing: MemoryStanding, replacementId: string | undefined, at: string, effectiveAt = at): void => {
  const fact = state.facts[id];
  if (!fact) return;
  const terminal = ['superseded', 'contradicted'].includes(standing);
  if (!terminal && ['superseded', 'contradicted'].includes(fact.standing)) return;
  const cutoff = Math.max(Date.parse(fact.validAt ?? fact.recordedAt),
    Math.min(Date.parse(effectiveAt), fact.invalidAt ? Date.parse(fact.invalidAt) : Infinity));
  const next: FactRecord = { ...fact, standing, ...(replacementId ? { replacementId } : {}),
    ...(terminal ? { expiredAt: fact.expiredAt ?? new Date(Date.parse(at)).toISOString(), invalidAt: new Date(cutoff).toISOString() } : {}) };
  state.facts[id] = next;
  if (terminal) {
    const key = documentKey({ namespace: 'memory', externalId: id });
    const mirrored = state.documents[key];
    if (mirrored) mirrored.document = { ...mirrored.document, validTo: new Date(cutoff).toISOString() };
  }
  if (replacementId) link(state, replacementId, id, 'resolves');
};
const insertFact = (state: State, fact: TemporalFact, recordedAt: string): void => {
  if (state.facts[fact.id]) return;
  const scopeKind: SourceDocument['scopeKind'] = fact.scopeId === 'shared' ? 'shared' : fact.scopeId.startsWith('p_') ? 'project' : 'team';
  upsertDocument(state, { namespace: 'memory', externalId: fact.id, scopeId: fact.scopeId, scopeKind,
    source: 'pi-memory', kind: fact.kind, title: fact.subject ?? fact.statement.slice(0, 100), text: fact.statement,
    version: sha256(JSON.stringify(fact)), contentHash: sha256(fact.statement), observedAt: fact.recordedAt,
    ...(fact.validAt ? { validFrom: fact.validAt } : {}), ...(fact.invalidAt ? { validTo: fact.invalidAt } : {}),
    trust: fact.evidence.some(item => item.provenance === 'native_observation') ? 'host'
      : fact.evidence.some(item => item.provenance === 'declared') ? 'user' : 'agent', metadata: fact.tags });
  state.facts[fact.id] = { ...fact };
  state.factEvidence[fact.id] = fact.evidence.map(item => item.id);
  for (const evidence of fact.evidence) insertEvidence(state, evidence);
  state.factEntities[fact.id] = fact.entities.map(item => item.id);
  for (const entity of fact.entities) {
    const prior = state.entities[entity.id];
    state.entities[entity.id] = { ...entity, ...(entity.summary ?? prior?.summary ? { summary: entity.summary ?? prior!.summary! } : {}) };
  }
  state.factEpisodes[fact.id] = [...fact.episodeIds];
  for (const replaced of fact.supersedes ?? []) {
    link(state, fact.id, replaced, 'supersedes');
    resolveFactState(state, replaced, 'superseded', fact.id, recordedAt, fact.validAt ?? fact.recordedAt);
  }
};
const applyToState = (state: State, event: MemoryEvent): void => {
  const payload = event.payload;
  if (payload.type === 'document.upserted') upsertDocument(state, payload.document);
  if (payload.type === 'document.deleted') deleteDocumentKey(state, documentKey({ namespace: payload.namespace, externalId: payload.externalId }), event.recordedAt);
  if (payload.type === 'episode.recorded') {
    const episode = payload.episode;
    if (!state.episodes[episode.id]) {
      const { evidence, ...rest } = episode;
      state.episodes[episode.id] = { ...rest, evidenceIds: evidence.map(item => item.id) };
    }
    for (const evidence of episode.evidence) insertEvidence(state, evidence);
  }
  if (payload.type === 'fact.recorded') insertFact(state, payload.fact, event.recordedAt);
  if (payload.type === 'fact.resolved') resolveFactState(state, payload.factId, payload.standing, payload.replacementId, event.recordedAt);
  if (payload.type === 'retrieval.feedback') {
    const current = state.usefulness[payload.factId] ?? { used: 0, helpful: 0, wrong: 0, stale: 0, lastSignalAt: 0 };
    state.usefulness[payload.factId] = { ...current, [payload.signal]: current[payload.signal] + 1, lastSignalAt: Date.parse(event.recordedAt) };
  }
  if (payload.type === 'gc.compacted') for (const key of payload.removed) deleteDocumentKey(state, key, event.recordedAt);
  if (payload.type === 'curation.batch.commit') {
    for (const fact of payload.facts) insertFact(state, fact, event.recordedAt);
    for (const document of payload.documents) upsertDocument(state, document);
    for (const item of payload.resolves ?? []) resolveFactState(state, item.factId, item.standing, undefined, event.recordedAt);
  }
};

// ------------------------------------------------------------- projection

export class CompactProjection {
  readonly path: string;
  /** Compact mode intentionally exposes no SQL driver; retained only so the
   * legacy Projection-shaped public field fails explicitly rather than leaking
   * an unrelated connection. */
  get db(): never { throw new Error('Compact memory has no public SQL projection driver.'); }
  constructor(private readonly store: CompactStore) { this.path = store.path; }
  exportSnapshot(destination: string): void { this.store.exportSnapshot(destination); }
  private get state(): State { return this.store.state(); }

  hasEvent(id: string): boolean { return Boolean(this.state.applied[id]); }
  apply(event: MemoryEvent): boolean { return this.store.applyEvent(event); }
  transaction<T>(action: () => T): T { return this.store.transaction(action); }

  getFact(id: string): StoredFact | undefined {
    const state = this.state;
    const fact = state.facts[id];
    if (!fact) return undefined;
    const use = state.usefulness[id];
    const supersedes = state.links.filter(item => item.from === id && item.relation === 'supersedes')
      .map(item => item.to).sort((a, b) => a.localeCompare(b));
    return {
      id, scopeId: fact.scopeId, kind: fact.kind, statement: fact.statement,
      ...(fact.subject ? { subject: fact.subject } : {}), ...(fact.predicate ? { predicate: fact.predicate } : {}),
      ...(fact.object ? { object: fact.object } : {}), standing: fact.standing, confidence: fact.confidence,
      ...(fact.validAt ? { validAt: fact.validAt } : {}), ...(fact.invalidAt ? { invalidAt: fact.invalidAt } : {}),
      recordedAt: fact.recordedAt, ...(fact.expiredAt ? { expiredAt: fact.expiredAt } : {}), tags: fact.tags,
      entities: (state.factEntities[id] ?? []).flatMap(key => state.entities[key] ? [state.entities[key]!] : []),
      evidence: (state.factEvidence[id] ?? []).flatMap(key => state.evidence[key] ? [state.evidence[key]!] : []),
      episodeIds: state.factEpisodes[id] ?? [],
      ...(supersedes.length ? { supersedes } : {}),
      usefulness: use ? use.used + 2 * use.helpful - 3 * use.wrong - 2 * use.stale : 0,
    };
  }

  getFacts(ids: readonly string[]): StoredFact[] { return ids.flatMap(id => this.getFact(id) ?? []); }

  activeFacts(scopeId: string, limit = 1_000): StoredFact[] {
    return Object.values(this.state.facts)
      .filter(fact => fact.scopeId === scopeId && ['supported', 'needs_review', 'candidate'].includes(fact.standing))
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
      .slice(0, Math.max(1, limit)).flatMap(fact => this.getFact(fact.id) ?? []);
  }

  activeDocuments(options: { limit?: number; after?: string } = {}): SourceDocument[] {
    const limit = Math.max(1, Math.min(10_000, options.limit ?? 1_000));
    return Object.entries(this.state.documents)
      .filter(([key, entry]) => entry.deletedAt === null && (options.after === undefined || key > options.after))
      // SQLite orders TEXT keys by byte value, and document keys embed a NUL
      // separator; locale collation would reorder namespaces against the index.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit).map(([, entry]) => entry.document);
  }

  *eachActiveDocument(batch = 1_000): Generator<SourceDocument> {
    const cursor: { after?: string } = {};
    for (;;) {
      const page = this.activeDocuments({ limit: batch, ...(cursor.after === undefined ? {} : { after: cursor.after }) });
      for (const document of page) yield document;
      if (page.length < batch) return;
      cursor.after = documentKey(page[page.length - 1]!);
    }
  }

  documentByKey(document: Pick<SourceDocument, 'namespace' | 'externalId'>): SourceDocument | undefined {
    const entry = this.state.documents[documentKey(document)];
    return entry && entry.deletedAt === null ? entry.document : undefined;
  }

  upsertDocument(document: SourceDocument): void {
    this.store.transaction(() => upsertDocument(this.state, document));
  }

  deleteDocument(namespace: string, externalId: string, at: string): void {
    this.store.transaction(() => deleteDocumentKey(this.state, documentKey({ namespace, externalId }), at));
  }

  replaceChunks(key: string, chunks: readonly DocumentChunk[], _title?: string): void {
    this.replaceChunksBatch(chunks, new Map([[key, _title ?? '']]));
  }

  replaceChunksBatch(chunks: readonly DocumentChunk[], titles?: ReadonlyMap<string, string>): void {
    this.store.transaction(() => {
      const keys = new Set([...chunks.map(chunk => chunk.documentKey), ...(titles ? [...titles.keys()] : [])]);
      for (const key of keys) {
        for (const id of Object.keys(this.state.chunks)) if (this.state.chunks[id]!.documentKey === key) dropChunk(this.state, id);
      }
      for (const chunk of chunks) this.state.chunks[chunk.id] = chunk;
    });
  }

  chunksMatch(document: Pick<SourceDocument, 'namespace' | 'externalId'>, chunks: readonly DocumentChunk[], title?: string): boolean {
    const current = Object.values(this.state.chunks).filter(chunk => chunk.documentKey === documentKey(document))
      .sort((left, right) => left.ordinal - right.ordinal);
    const storedTitle = this.state.documents[documentKey(document)]?.document.title;
    return storedTitle === title && current.length === chunks.length && current.every((chunk, index) => chunk.id === chunks[index]?.id
      && JSON.stringify(chunk.metadata) === JSON.stringify(chunks[index]?.metadata ?? {}));
  }

  chunkIds(document: Pick<SourceDocument, 'namespace' | 'externalId'>): string[] {
    const key = documentKey(document);
    return Object.values(this.state.chunks).filter(chunk => chunk.documentKey === key)
      .sort((left, right) => left.ordinal - right.ordinal).map(chunk => chunk.id);
  }

  chunkCount(document: Pick<SourceDocument, 'namespace' | 'externalId'>): number {
    return this.chunkIds(document).length;
  }

  chunks(ids: readonly string[]): Array<DocumentChunk & { document: SourceDocument }> {
    const state = this.state;
    return ids.flatMap(id => {
      const chunk = state.chunks[id];
      const entry = chunk ? state.documents[chunk.documentKey] : undefined;
      return chunk && entry ? [{ ...chunk, document: entry.document }] : [];
    });
  }

  retrievalChunks(ids: readonly string[]): Array<DocumentChunk & { document: SourceDocument }> {
    return this.chunks(ids).map(chunk => ({ ...chunk, document: { ...chunk.document, text: '' } }));
  }

  *eachDocumentHash(batch = 1_000): Generator<{ documentKey: string; contentHash: string; adapter?: string; revision?: string }> {
    for (const document of this.eachActiveDocument(batch)) {
      yield { documentKey: documentKey(document), contentHash: document.contentHash,
        ...(document.sync?.adapter ? { adapter: document.sync.adapter, revision: document.sync.revision } : {}) };
    }
  }

  hasVector(chunkId: string, model: string): boolean { return this.state.vectors[chunkId]?.model === model; }

  /** Derived, never authority: vectors follow their chunk's lifetime. */
  storeVectors(rows: readonly { chunkId: string; vector: readonly number[] }[], model: string): void {
    if (!rows.length) return;
    const dims = rows[0]!.vector.length;
    if (rows.some(row => row.vector.length !== dims)) throw new Error('Embedding batch dimensions differ.');
    if (rows.some(row => row.vector.some(value => !Number.isFinite(value)))) throw new Error('Embedding vectors must be finite.');
    if (!Number.isSafeInteger(dims) || dims < 8 || dims > 8192) throw new Error('Invalid embedding dimensions.');
    this.store.transaction(() => {
      for (const row of rows) {
        const norm = Math.sqrt(row.vector.reduce((sum, value) => sum + value * value, 0));
        const values = row.vector.map(value => Math.max(-127, Math.min(127, Math.round(norm ? value * 127 / norm : 0))));
        this.state.vectors[row.chunkId] = { model, dims, values };
      }
    });
  }

  storeVector(chunkId: string, model: string, vector: readonly number[]): void { this.storeVectors([{ chunkId, vector }], model); }

  storedVector(chunkId: string): { model: string; dims: number; values: number[] } | undefined { return this.state.vectors[chunkId]; }

  vectorSearch(model: string, dims: number, vector: readonly number[], limit: number): Array<{
    chunkId: string; documentKey: string; distance: number; dimensions: number; similarity: number;
  }> {
    if (vector.some(value => !Number.isFinite(value))) throw new Error('Embedding query must be finite.');
    if (!Number.isSafeInteger(dims) || dims < 8 || dims > 8192 || vector.length !== dims) throw new Error('Invalid embedding dimensions.');
    const queryNorm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return Object.entries(this.state.vectors).flatMap(([chunkId, stored]) => {
      const chunk = this.state.chunks[chunkId];
      if (!chunk || stored.model !== model || stored.dims !== dims) return [];
      const storedNorm = Math.sqrt(stored.values.reduce((sum, value) => sum + value * value, 0));
      const dot = stored.values.reduce((sum, value, index) => sum + value * vector[index]!, 0);
      const similarity = storedNorm && queryNorm ? Math.max(-1, Math.min(1, dot / (storedNorm * queryNorm))) : 0;
      return [{ chunkId, documentKey: chunk.documentKey, distance: Math.sqrt(Math.max(0, 2 - 2 * similarity)), dimensions: dims, similarity }];
    }).sort((a, b) => a.distance - b.distance || a.chunkId.localeCompare(b.chunkId)).slice(0, Math.max(1, Math.min(1_000, limit)));
  }

  unembeddedChunks(model: string): Array<DocumentChunk & { document: SourceDocument }> {
    const state = this.state;
    return this.chunks(Object.keys(state.chunks).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(id => state.vectors[id]?.model !== model)
      .filter(id => state.documents[state.chunks[id]!.documentKey]?.deletedAt === null));
  }

  lexicalStatistics(terms: readonly string[]): { documents: number; tokens: number; frequencies: ReadonlyMap<string, number> } {
    const chunks = Object.values(this.state.chunks);
    const searchable = (chunk: DocumentChunk): string => `${this.state.documents[chunk.documentKey]?.document.title ?? ''}\n${chunk.text}\n${Object.values(chunk.metadata).join(' ')}`;
    const wanted = new Set(terms.flatMap(words));
    const frequencies = new Map<string, number>();
    for (const term of wanted) frequencies.set(term, chunks.filter(chunk => new Set(words(searchable(chunk))).has(term)).length);
    return { documents: chunks.length, tokens: chunks.reduce((sum, chunk) => sum + words(searchable(chunk)).length, 0), frequencies };
  }

  selectiveTerms(tokens: readonly string[]): string[] {
    const unique = [...new Set(tokens.map(token => token.toLocaleLowerCase()))];
    if (unique.length <= 3) return unique;
    const chunks = Object.values(this.state.chunks);
    const counts = new Map(unique.map(token => [token, chunks.filter(chunk => tokenSequencePresent(chunk.text, token)).length]));
    const ranked = [...unique].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0));
    const ceiling = chunks.length >= 5_000 ? chunks.length * 0.05 : Number.POSITIVE_INFINITY;
    const informative = ranked.filter(term => (counts.get(term) ?? 0) <= ceiling);
    return (informative.length >= 3 ? informative : ranked.slice(0, 3)).slice(0, 12);
  }

  lexicalSearch(query: string, limit: number): Array<{ chunkId: string; documentKey: string; score: number }> {
    const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? [];
    const terms = this.selectiveTerms(tokens.slice(0, 64));
    if (!terms.length) return [];
    const state = this.state;
    const candidates = Object.values(state.chunks).filter(chunk => terms.some(term => tokenSequencePresent(
      `${state.documents[chunk.documentKey]?.document.title ?? ''}\n${chunk.text}\n${Object.values(chunk.metadata).join(' ')}`, term)))
      .map(chunk => ({ key: chunk.id, title: state.documents[chunk.documentKey]?.document.title, statement: chunk.text }));
    const scores = rankLexically(candidates, [terms.join(' ')], [this.lexicalStatistics(terms)])[0]!;
    return candidates.flatMap(candidate => {
      const score = scores.get(candidate.key);
      const chunk = state.chunks[candidate.key];
      return score && chunk ? [{ chunkId: chunk.id, documentKey: chunk.documentKey, score }] : [];
    }).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, Math.max(1, Math.min(1_000, limit)));
  }

  exactSearch(query: string, limit: number): Array<{ chunkId: string; documentKey: string; score: number }> {
    const capped = Math.max(1, Math.min(1_000, limit));
    const state = this.state;
    return Object.values(state.chunks).filter(chunk => chunk.id === query
      || state.documents[chunk.documentKey]?.document.externalId === query
      || (query.length <= 160 && (chunk.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        || state.documents[chunk.documentKey]?.document.uri?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, capped)
      .map(chunk => ({ chunkId: chunk.id, documentKey: chunk.documentKey, score: 1 }));
  }

  chunkWindow(chunkId: string, maxChars = 2_400): { text: string; chunkIds: string[] } | undefined {
    const first = this.state.chunks[chunkId];
    if (!first) return undefined;
    return Object.values(this.state.chunks).filter(chunk => chunk.documentKey === first.documentKey && chunk.ordinal >= first.ordinal)
      .sort((a, b) => a.ordinal - b.ordinal).slice(0, 3).reduce<{ text: string; chunkIds: string[] }>((window, chunk) => {
        if (window.text.length >= maxChars) return window;
        const next = `${window.text ? '\n\n' : ''}${chunk.text}`;
        return { text: `${window.text}${next}`.slice(0, maxChars), chunkIds: [...window.chunkIds, chunk.id] };
      }, { text: '', chunkIds: [] });
  }

  graphNeighbors(factIds: readonly string[], limit: number): StoredFact[] {
    const state = this.state;
    const entities = new Set(factIds.flatMap(id => state.factEntities[id] ?? []));
    return Object.keys(state.facts)
      .filter(id => !factIds.includes(id) && (state.factEntities[id] ?? []).some(entity => entities.has(entity)))
      .filter(id => state.documents[documentKey({ namespace: 'memory', externalId: id })]?.deletedAt === null)
      .sort((a, b) => Date.parse(state.facts[b]!.recordedAt) - Date.parse(state.facts[a]!.recordedAt))
      .slice(0, Math.max(0, limit)).flatMap(id => this.getFact(id) ?? []);
  }

  gcCandidates(now = Date.now()): string[] {
    const state = this.state;
    return Object.entries(state.documents).filter(([key, entry]) => {
      if (entry.deletedAt !== null) return true;
      if (entry.document.namespace !== 'memory') return false;
      const fact = state.facts[entry.document.externalId];
      if (!fact) return false;
      const use = state.usefulness[fact.id];
      const positive = (use?.used ?? 0) + (use?.helpful ?? 0);
      const recorded = Date.parse(fact.recordedAt);
      if (['superseded', 'contradicted'].includes(fact.standing)) {
        return Math.max(fact.expiredAt ? Date.parse(fact.expiredAt) : recorded,
          fact.invalidAt ? Date.parse(fact.invalidAt) : recorded) < now - 7 * 86_400_000;
      }
      return ['candidate', 'needs_review'].includes(fact.standing) && positive === 0 && recorded < now - 30 * 86_400_000;
    }).map(([key]) => key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 10_000);
  }

  gcProjection(reachableDocumentKeys: ReadonlySet<string>): string[] {
    const removable = Object.entries(this.state.documents)
      .filter(([key, entry]) => entry.deletedAt !== null && !reachableDocumentKeys.has(key))
      .map(([key]) => key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!removable.length) return [];
    return this.store.transaction(() => {
      for (const key of removable) {
        for (const id of Object.keys(this.state.chunks)) if (this.state.chunks[id]!.documentKey === key) dropChunk(this.state, id);
        delete this.state.documents[key];
      }
      return removable;
    });
  }

  stats(): { documents: number; chunks: number; vectors: number; facts: number; events: number; bytes: number } {
    const state = this.state;
    const bytes = [this.path, `${this.path}-wal`, `${this.path}-shm`]
      .reduce((sum, path) => sum + (statSync(path, { throwIfNoEntry: false })?.size ?? 0), 0);
    return { documents: Object.keys(state.documents).length, chunks: Object.keys(state.chunks).length,
      vectors: Object.keys(state.vectors).length,
      facts: Object.keys(state.facts).length, events: Object.keys(state.applied).length, bytes };
  }

  checkpointWal(): { status: 'checkpointed' | 'busy'; logFrames: number; checkpointedFrames: number } {
    const status = this.store.checkpoint();
    return { status, logFrames: 0, checkpointedFrames: 0 };
  }

  walPublicationPaused(): boolean { return this.store.publicationPaused(); }

  close(): void { /* CompactStore owns the one connection. */ }

  activity(): SyncActivity { return this.state.activity; }

  recordActivity(delta: Readonly<{ turns?: number; tokens?: number; inserts?: number }>, at = Date.now()): SyncActivity {
    const turns = Math.max(0, Math.trunc(delta.turns ?? 0));
    const tokens = Math.max(0, Math.trunc(delta.tokens ?? 0));
    const inserts = Math.max(0, Math.trunc(delta.inserts ?? 0));
    if (!turns && !tokens && !inserts) return this.activity();
    return this.store.transaction(() => {
      const state = this.state;
      state.activity = { turns: state.activity.turns + turns, tokens: state.activity.tokens + tokens,
        inserts: state.activity.inserts + inserts, updatedAt: at };
      return state.activity;
    });
  }

  syncState(adapter: string): SyncRun | undefined { return this.state.sync[adapter]; }
  syncStates(limit = 1_000): SyncRun[] {
    return Object.values(this.state.sync).sort((a, b) => a.adapter.localeCompare(b.adapter)).slice(0, limit);
  }

  recordSync(adapter: string, run: Readonly<{ at?: number; discovered: number; indexed: number; ok: boolean; detail?: string }>): SyncRun {
    return this.store.transaction(() => {
      const state = this.state;
      const at = run.at ?? Date.now();
      const mark = state.activity;
      state.sync[adapter] = { adapter, lastAt: new Date(at).toISOString(),
        at: { turns: mark.turns, tokens: mark.tokens, inserts: mark.inserts, updatedAt: at },
        discovered: run.discovered, indexed: run.indexed, ok: run.ok, ...(run.detail ? { detail: run.detail } : {}) };
      return state.sync[adapter]!;
    });
  }

  sourceGaps(): string[] {
    const state = this.state;
    const adapters = [...new Set(Object.values(state.documents)
      .filter(entry => entry.deletedAt === null && entry.document.sync?.adapter)
      .map(entry => entry.document.sync!.adapter))];
    return adapters.filter(adapter => !state.sync[adapter]?.ok)
      .map(adapter => `Source ${adapter} could not be fully checked; retained content may be stale.`);
  }

  private assertOwner(projectId: string): void {
    if (projectId !== this.store.projectId) throw new Error('Operational checkpoint projectId does not own this memory database.');
  }

  operationalCheckpoint(projectId: string, sessionId: string): string | undefined {
    this.assertOwner(projectId);
    return this.state.checkpoints[`${projectId}\u0000${sessionId}`]?.body;
  }

  upsertOperationalCheckpoint(projectId: string, sessionId: string, body: string, updatedAt: number): boolean {
    this.assertOwner(projectId);
    return this.store.transaction(() => {
      const state = this.state;
      const key = `${projectId}\u0000${sessionId}`;
      const current = state.checkpoints[key];
      if (current && updatedAt < current.updatedAt) return false;
      state.checkpoints[key] = { body, updatedAt };
      return true;
    });
  }
}

// --------------------------------------------------------------- curation

export class CompactCuration {
  get db(): never { throw new Error('Compact memory has no public SQL curation driver.'); }
  constructor(private readonly store: CompactStore) {}
  private get state(): State['curation'] { return this.store.state().curation; }
  transaction<T>(action: () => T): T { return this.store.transaction(action); }
  close(): void { /* CompactStore owns the one connection. */ }

  fingerprint(documentKeyValue: string): SourceIdentity | undefined {
    const record = this.state.fingerprints[documentKeyValue];
    if (!record || record.withdrawnAt) return undefined;
    const { withdrawnAt, updatedAt, ...identity } = record;
    return identity;
  }
  fingerprintOwner(documentKeyValue: string): string | undefined { return this.state.fingerprints[documentKeyValue]?.adapter; }
  adapterFingerprints(adapter: string): SourceIdentity[] {
    return Object.values(this.state.fingerprints).filter(record => record.adapter === adapter && !record.withdrawnAt)
      .map(({ withdrawnAt, updatedAt, ...identity }) => identity);
  }
  fingerprintAgeMs(documentKeyValue: string, now = Date.now()): number | undefined {
    const record = this.state.fingerprints[documentKeyValue];
    return record && !record.withdrawnAt ? now - record.updatedAt : undefined;
  }

  upsertFingerprint(identity: SourceIdentity, at = Date.now()): void {
    this.store.transaction(() => {
      const state = this.state;
      const prior = this.fingerprint(identity.documentKey);
      if (prior && (prior.revision !== identity.revision || prior.contentHash !== identity.contentHash)) delete state.coverage[identity.documentKey];
      state.fingerprints[identity.documentKey] = { ...identity, updatedAt: at };
    });
  }
  markWithdrawn(documentKeyValue: string, at = Date.now()): void {
    this.store.transaction(() => {
      const record = this.state.fingerprints[documentKeyValue];
      if (record) { record.withdrawnAt = at; record.updatedAt = at; }
    });
  }
  touchFingerprint(documentKeyValue: string, at = Date.now()): void {
    this.store.transaction(() => {
      const record = this.state.fingerprints[documentKeyValue];
      if (record && !record.withdrawnAt) record.updatedAt = at;
    });
  }

  getJob(id: string): CurationJob | undefined {
    const job = this.state.jobs[id];
    return job ? jobView(job) : undefined;
  }
  openJobs(limit = 1_000): CurationJob[] {
    return Object.values(this.state.jobs).filter(job => ['pending', 'claimed', 'failed', 'blocked'].includes(job.status))
      .sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map(jobView);
  }

  enqueue(job: Omit<CurationJob, 'attempts' | 'createdAt' | 'updatedAt' | 'nextAttemptAt' | 'status'> & Readonly<{
    status?: JobStatus; attempts?: number; nextAttemptAt?: number }>, at = Date.now()): CurationJob {
    return this.store.transaction(() => {
      const state = this.state;
      const insert = (generation: number): CurationJob => {
        const id = generation === 0 ? job.id : jobIdFor(job.scopeId, job.action, job.documentKey, job.inputRevision, String(generation));
        const existing = state.jobs[id];
        if (existing && !TERMINAL.includes(existing.status)) return jobView(existing);
        if (existing) {
          if (generation > 512) throw new Error('Curation job generation exhausted.');
          return insert(generation + 1);
        }
        state.jobs[id] = { id, scopeId: job.scopeId, adapter: job.adapter, documentKey: job.documentKey, action: job.action,
          status: job.status ?? 'pending', inputRevision: job.inputRevision, contentHash: job.contentHash,
          ...(job.topicRevision ? { topicRevision: job.topicRevision } : {}), attempts: job.attempts ?? 0,
          nextAttemptAt: job.nextAttemptAt ?? 0, createdAt: at, updatedAt: at };
        return jobView(state.jobs[id]!);
      };
      return insert(0);
    });
  }

  discardOpenJobs(documentKeyValue: string, exceptRevision: string, at = Date.now()): number {
    return this.store.transaction(() => {
      const affected = Object.values(this.state.jobs).filter(job => job.documentKey === documentKeyValue
        && job.inputRevision !== exceptRevision && ['pending', 'failed', 'blocked', 'claimed'].includes(job.status));
      for (const job of affected) {
        this.state.jobs[job.id] = { ...job, status: 'discarded', updatedAt: at, leaseOwner: undefined, leaseUntil: undefined };
      }
      return affected.length;
    });
  }

  claim(owner: string, leaseMs: number, now = Date.now()): CurationJob | undefined {
    return this.store.transaction(() => {
      const eligible = Object.values(this.state.jobs).filter(job => job.nextAttemptAt <= now
        && ((['pending', 'failed'].includes(job.status) && (job.leaseUntil === undefined || job.leaseUntil < now))
          || (job.status === 'claimed' && (job.leaseUntil ?? 0) < now)))
        .sort((a, b) => a.createdAt - b.createdAt);
      const job = eligible[0];
      if (!job) return undefined;
      const held: CurationJob = { ...job, status: 'claimed', leaseOwner: owner, leaseUntil: now + Math.max(1, leaseMs),
        attempts: job.attempts + 1, updatedAt: now };
      this.state.jobs[job.id] = held;
      return jobView(held);
    });
  }

  release(id: string, owner: string, at = Date.now()): void {
    this.store.transaction(() => {
      const job = this.state.jobs[id];
      if (!job || job.leaseOwner !== owner || job.status !== 'claimed') return;
      this.state.jobs[id] = { ...job, status: 'pending', leaseOwner: undefined, leaseUntil: undefined, updatedAt: at };
    });
  }

  finish(id: string, owner: string, outcome: Extract<JobStatus, 'published' | 'no_change' | 'discarded'>,
    outputRevision: string | undefined, at = Date.now(), watermark = true): boolean {
    return this.store.transaction(() => {
      const job = this.state.jobs[id];
      if (!job || !stillHeld(jobView(job), owner, at)) return false;
      this.state.jobs[id] = { ...job, status: outcome, ...(outputRevision ? { outputRevision } : { outputRevision: undefined }),
        publishedAt: at, leaseOwner: undefined, leaseUntil: undefined, updatedAt: at, errorCode: undefined, errorDetail: undefined };
      if (watermark) this.state.watermarks[`${job.adapter}\u0000${job.documentKey}`] = { revision: job.inputRevision, outcome, at };
      return true;
    });
  }

  fail(id: string, owner: string, code: string, detail: string, retryAt: number, blocked = false, at = Date.now()): void {
    this.store.transaction(() => {
      const job = this.state.jobs[id];
      if (!job || job.leaseOwner !== owner || job.status !== 'claimed') return;
      this.state.jobs[id] = { ...job, status: blocked ? 'blocked' : 'failed', errorCode: code, errorDetail: sanitizeDetail(detail),
        nextAttemptAt: retryAt, leaseOwner: undefined, leaseUntil: undefined, updatedAt: at };
    });
  }

  renew(id: string, owner: string, leaseMs: number, now = Date.now()): boolean {
    return this.store.transaction(() => {
      const job = this.state.jobs[id];
      if (!job || job.leaseOwner !== owner || job.status !== 'claimed') return false;
      this.state.jobs[id] = { ...job, leaseUntil: now + Math.max(1, leaseMs), updatedAt: now };
      return true;
    });
  }

  blockOpen(code: string, detail: string, at = Date.now()): number {
    return this.store.transaction(() => {
      const affected = Object.values(this.state.jobs).filter(job => ['pending', 'failed'].includes(job.status));
      for (const job of affected) this.state.jobs[job.id] = { ...job, status: 'blocked', errorCode: code, errorDetail: sanitizeDetail(detail), updatedAt: at };
      return affected.length;
    });
  }

  unblock(code: string, at = Date.now()): number {
    return this.store.transaction(() => {
      const affected = Object.values(this.state.jobs).filter(job => job.status === 'blocked' && job.errorCode === code);
      for (const job of affected) {
        this.state.jobs[job.id] = { ...job, status: 'pending', errorCode: undefined, errorDetail: undefined, nextAttemptAt: 0, updatedAt: at };
      }
      return affected.length;
    });
  }

  watermark(adapter: string, documentKeyValue: string): { revision: string; outcome: string } | undefined {
    const record = this.state.watermarks[`${adapter}\u0000${documentKeyValue}`];
    return record ? { revision: record.revision, outcome: record.outcome } : undefined;
  }

  topic(id: string): { id: string; scopeId: string; title: string; summary: string; revision: number; factIds: string[] } | undefined {
    const topic = this.state.topics[id];
    return topic ? { id: topic.id, scopeId: topic.scopeId, title: topic.title, summary: topic.summary, revision: topic.revision, factIds: topic.factIds } : undefined;
  }
  topicRevision(id: string): number { return this.state.topics[id]?.revision ?? 0; }

  writeTopic(topic: { id: string; scopeId: string; title: string; summary: string; factIds: readonly string[] }, expectedRevision: number, at = Date.now()): number | undefined {
    return this.store.transaction(() => {
      const current = this.topicRevision(topic.id);
      if (current !== expectedRevision) return undefined;
      const next = current + 1;
      this.state.topics[topic.id] = { id: topic.id, scopeId: topic.scopeId, title: topic.title, summary: topic.summary,
        revision: next, summaryHash: sha256(topic.summary), factIds: [...topic.factIds], updatedAt: at };
      return next;
    });
  }

  linkFact(factId: string, identity: Pick<SourceIdentity, 'documentKey' | 'adapter' | 'revision'>): void {
    this.store.transaction(() => {
      this.state.dependencies[`${factId}\u0000${identity.documentKey}`] = { factId, documentKey: identity.documentKey,
        adapter: identity.adapter, revision: identity.revision };
    });
  }

  dependents(documentKeyValue: string, revision?: string): string[] {
    return Object.values(this.state.dependencies)
      .filter(item => item.documentKey === documentKeyValue && (revision === undefined || item.revision === revision))
      .map(item => item.factId);
  }

  spend(at = Date.now()): Spend {
    const day = utcDay(at);
    const record = this.state.spend[day];
    return { day, calls: record?.calls ?? 0, inputTokens: record?.inputTokens ?? 0,
      outputTokens: record?.outputTokens ?? 0, embeddingCalls: record?.embeddingCalls ?? 0 };
  }

  recordSpend(delta: Readonly<{ calls?: number; inputTokens?: number; outputTokens?: number; embeddingCalls?: number }>, at = Date.now()): Spend {
    return this.store.transaction(() => {
      const current = this.spend(at);
      const next: Spend = { day: current.day,
        calls: current.calls + Math.max(0, Math.trunc(delta.calls ?? 0)),
        inputTokens: current.inputTokens + Math.max(0, Math.trunc(delta.inputTokens ?? 0)),
        outputTokens: current.outputTokens + Math.max(0, Math.trunc(delta.outputTokens ?? 0)),
        embeddingCalls: current.embeddingCalls + Math.max(0, Math.trunc(delta.embeddingCalls ?? 0)) };
      this.state.spend[current.day] = next;
      return next;
    });
  }

  reserveCall(budget: { maxCallsPerDay: number; maxTokensPerDay: number }, at = Date.now(), tokens = 0): boolean {
    return this.store.transaction(() => {
      const current = this.spend(at);
      if (current.calls >= budget.maxCallsPerDay || (current.inputTokens + current.outputTokens + tokens) > budget.maxTokensPerDay) return false;
      this.recordSpend({ calls: 1, inputTokens: Math.max(0, tokens) }, at);
      return true;
    });
  }

  coverage(documentKeyValue: string): { offset: number; total: number } | undefined {
    const record = this.state.coverage[documentKeyValue];
    return record ? { offset: record.offset, total: record.total } : undefined;
  }

  setCoverage(documentKeyValue: string, offset: number, total: number, at = Date.now()): void {
    this.store.transaction(() => {
      if (offset >= total) { delete this.state.coverage[documentKeyValue]; return; }
      this.state.coverage[documentKeyValue] = { offset, total, updatedAt: at };
    });
  }

  windowDrafts(documentKeyValue: string, revision: string): readonly { offset: number; factIds: readonly string[]; qualifications: readonly string[]; summary: string }[] {
    return Object.entries(this.state.drafts)
      .filter(([key]) => key.startsWith(`${documentKeyValue}\u0000${revision}\u0000`))
      .map(([, draft]) => draft).sort((a, b) => a.offset - b.offset)
      .map(draft => ({ offset: draft.offset, factIds: draft.factIds, qualifications: draft.qualifications, summary: draft.summary }));
  }

  saveWindowDraft(documentKeyValue: string, revision: string, offset: number, factIds: readonly string[], qualifications: readonly string[], summary: string): void {
    this.store.transaction(() => {
      this.state.drafts[`${documentKeyValue}\u0000${revision}\u0000${offset}`] = { offset, factIds: [...factIds],
        qualifications: [...qualifications], summary: summary.slice(0, 1500) };
    });
  }

  clearWindowDrafts(documentKeyValue: string, revision: string): void {
    this.store.transaction(() => {
      for (const key of Object.keys(this.state.drafts)) {
        if (key.startsWith(`${documentKeyValue}\u0000${revision}\u0000`)) delete this.state.drafts[key];
      }
    });
  }

  stats(at = Date.now()): CurationStats {
    const jobs = Object.values(this.state.jobs);
    const count = (status: JobStatus): number => jobs.filter(job => job.status === status).length;
    return { fingerprints: Object.values(this.state.fingerprints).filter(record => !record.withdrawnAt).length,
      pending: count('pending'), claimed: count('claimed'), failed: count('failed'), blocked: count('blocked'),
      published: count('published'), spend: this.spend(at) };
  }

  acceptBatch(job: CurationJob, identity: SourceIdentity, topicId: string, expectedTopic: number, payloads: unknown, owner: string, at = Date.now()): string | undefined {
    return this.store.transaction(() => {
      if (!stillHeld(this.getJob(job.id), owner, Date.now())) return undefined;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return undefined;
      if (this.topicRevision(topicId) !== expectedTopic) return undefined;
      const id = `batch_${sha256(`${job.id}\u0000${job.inputRevision}\u0000${at}`).slice(0, 24)}`;
      this.state.batches[id] = { id, jobId: job.id, documentKey: identity.documentKey, sourceRevision: job.inputRevision,
        contentHash: job.contentHash, topicExpected: expectedTopic, payloads: payloads as never, state: 'accepted', createdAt: at };
      return id;
    });
  }

  abortBatch(id: string): void {
    this.store.transaction(() => {
      const batch = this.state.batches[id];
      if (batch && ['accepted', 'committed', 'sealed', 'materializing'].includes(batch.state)) batch.state = 'aborted';
    });
  }

  pendingBatches(): readonly { id: string; payloads: unknown; sourceRevision: string; documentKey: string; jobId: string; state: string }[] {
    return Object.values(this.state.batches).filter(batch => ['committed', 'sealed', 'materializing'].includes(batch.state))
      .map(batch => ({ id: batch.id, payloads: batch.payloads, sourceRevision: batch.sourceRevision,
        documentKey: batch.documentKey, jobId: batch.jobId, state: batch.state }));
  }

  claimMaterialize(batchId: string): boolean {
    return this.store.transaction(() => {
      const batch = this.state.batches[batchId];
      if (!batch || !['committed', 'sealed'].includes(batch.state)) return false;
      batch.state = 'materializing';
      return true;
    });
  }

  batchRecord(id: string): { documentKey: string; sourceRevision: string; state: string } | undefined {
    const batch = this.state.batches[id];
    return batch ? { documentKey: batch.documentKey, sourceRevision: batch.sourceRevision, state: batch.state } : undefined;
  }

  acceptedBatch(jobId: string): { id: string; payloads: unknown; topicExpected: number; sourceRevision: string; state: string } | undefined {
    const batch = Object.values(this.state.batches)
      .filter(item => item.jobId === jobId && ['accepted', 'committed', 'sealed', 'materializing'].includes(item.state))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return batch ? { id: batch.id, payloads: batch.payloads, topicExpected: batch.topicExpected,
      sourceRevision: batch.sourceRevision, state: batch.state } : undefined;
  }

  commitBatch(batchId: string, job: CurationJob, identity: SourceIdentity, topicId: string, owner: string): boolean {
    return this.store.transaction(() => {
      if (!stillHeld(this.getJob(job.id), owner, Date.now())) return false;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return false;
      const batch = this.state.batches[batchId];
      if (!batch) return false;
      if (this.topicRevision(topicId) !== batch.topicExpected) return false;
      const payloads = (batch.payloads ?? {}) as { factIds?: unknown };
      const factIds = Array.isArray(payloads.factIds) ? payloads.factIds.filter((id): id is string => typeof id === 'string') : [];
      for (const id of factIds) this.linkFact(id, identity);
      if (batch.state !== 'accepted') return false;
      batch.state = 'committed';
      return true;
    });
  }

  sealCommitted(batchId: string, job: CurationJob, identity: SourceIdentity, topicId: string, owner: string, _at = Date.now()): boolean {
    return this.store.transaction(() => {
      const batch = this.state.batches[batchId];
      if (!batch) return false;
      if (['applied', 'sealed', 'materializing'].includes(batch.state)) return true;
      if (batch.state !== 'committed') return false;
      if (!stillHeld(this.getJob(job.id), owner, Date.now())) return false;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return false;
      if (this.topicRevision(topicId) !== batch.topicExpected) return false;
      batch.state = 'sealed';
      return true;
    });
  }

  markApplied(id: string): void {
    this.store.transaction(() => {
      const batch = this.state.batches[id];
      if (batch && batch.state === 'accepted') batch.state = 'applied';
    });
  }

  finishPublish(batchId: string, job: CurationJob, identity: SourceIdentity, topicId: string, at = Date.now(), fullSource = true): boolean {
    return this.store.transaction(() => {
      const batch = this.state.batches[batchId];
      if (!batch) return false;
      if (batch.state === 'applied') return true;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return false;
      const payloads = (batch.payloads ?? {}) as { documents?: { text?: string; title?: string }[]; factIds?: unknown };
      const factIds = Array.isArray(payloads.factIds) ? payloads.factIds.filter((id): id is string => typeof id === 'string') : [];
      const summary = payloads.documents?.[0]?.text ?? '';
      if (summary && this.topicRevision(topicId) === batch.topicExpected) {
        const next = this.writeTopic({ id: topicId, scopeId: job.scopeId,
          title: payloads.documents?.[0]?.title ?? identity.kind, summary, factIds }, batch.topicExpected, at);
        if (next === undefined) return false;
      }
      if (['committed', 'sealed', 'materializing'].includes(batch.state)) batch.state = 'applied';
      if (fullSource) {
        const current = this.state.jobs[job.id];
        if (current && ['claimed', 'failed'].includes(current.status)) {
          this.state.jobs[job.id] = { ...current, status: 'published', publishedAt: at, leaseOwner: undefined,
            leaseUntil: undefined, updatedAt: at, errorCode: undefined, errorDetail: undefined };
        }
        this.state.watermarks[`${job.adapter}\u0000${job.documentKey}`] = { revision: job.inputRevision, outcome: 'published', at };
      }
      return this.state.batches[batchId]?.state === 'applied';
    });
  }

  sealPublication(jobId: string, owner: string, batchId: string, outcome: 'published' | 'no_change', outputRevision: string | undefined, watermark: boolean, at = Date.now()): boolean {
    return this.store.transaction(() => {
      const job = this.state.jobs[jobId];
      if (!job || job.leaseOwner !== owner) return false;
      if (job.status === 'published' || job.status === 'no_change') return true;
      const batch = this.state.batches[batchId];
      if (batch?.state !== 'committed' && batch?.state !== 'applied') return false;
      if (job.status === 'claimed') {
        this.state.jobs[jobId] = { ...job, status: outcome, ...(outputRevision ? { outputRevision } : { outputRevision: undefined }),
          publishedAt: at, leaseOwner: undefined, leaseUntil: undefined, updatedAt: at, errorCode: undefined, errorDetail: undefined };
      }
      if (batch.state === 'committed') batch.state = 'applied';
      if (watermark) this.state.watermarks[`${job.adapter}\u0000${job.documentKey}`] = { revision: job.inputRevision, outcome, at };
      return true;
    });
  }

  finishWindow(jobId: string, owner: string, documentKeyValue: string, adapter: string, inputRevision: string, contentHash: string,
    scopeId: string, consumed: number, total: number, truncated: boolean, topicRevision: string | undefined, at = Date.now()): boolean {
    return this.store.transaction(() => {
      const job = this.state.jobs[jobId];
      if (!job || !stillHeld(jobView(job), owner, Date.now())) return false;
      const publish = (): void => {
        this.state.jobs[jobId] = { ...this.state.jobs[jobId]!, status: 'published', publishedAt: at, leaseOwner: undefined,
          leaseUntil: undefined, updatedAt: at, errorCode: undefined, errorDetail: undefined };
      };
      if (truncated) {
        if (consumed >= total) delete this.state.coverage[documentKeyValue];
        else this.state.coverage[documentKeyValue] = { offset: consumed, total, updatedAt: at };
        const open = Object.values(this.state.jobs).some(item => item.documentKey === documentKeyValue && item.action === 'analyze'
          && ['pending', 'claimed', 'failed', 'blocked'].includes(item.status) && item.id !== jobId);
        if (!open) {
          const contId = jobIdFor(scopeId, 'analyze', documentKeyValue, `${inputRevision}:cover:${consumed}`);
          const existing = this.state.jobs[contId];
          if (!existing || TERMINAL.includes(existing.status)) {
            this.enqueue({ id: contId, scopeId, adapter, documentKey: documentKeyValue, action: 'analyze',
              inputRevision, contentHash, ...(topicRevision ? { topicRevision } : {}) }, at);
          }
        }
        publish();
        return true;
      }
      delete this.state.coverage[documentKeyValue];
      const fingerprint = this.state.fingerprints[documentKeyValue];
      if (fingerprint && !fingerprint.withdrawnAt) fingerprint.updatedAt = at;
      publish();
      this.state.watermarks[`${adapter}\u0000${documentKeyValue}`] = { revision: inputRevision, outcome: 'published', at };
      return true;
    });
  }
}
