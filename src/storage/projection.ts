import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { DocumentChunk, SourceDocument } from '../contracts/documents.ts';
import { documentKey } from '../contracts/documents.ts';
import { chunkDocument } from '../vector/chunker.ts';
import type { EvidenceRef } from '../contracts/evidence.ts';
import type { MemoryEvent } from '../contracts/events.ts';
import type { Entity, Episode, MemoryStanding, TemporalFact } from '../contracts/memory.ts';
import { claimMemoryOwner, migrate } from './migrations.ts';
import { CurationStore } from '../curation/store.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { privateDatabaseFiles, privateDirectorySync } from './private-files.ts';
import { migrateIndexedPath } from './migration-coordinator.ts';
import { acquireMaintenanceLock } from './maintenance-lock.ts';

export const MAX_QUIESCENT_WAL_BYTES = 512 * 1024;
export type LexicalHit = Readonly<{ chunkId: string; documentKey: string; score: number }>;
/** distance is int8 L2 (not cosine); similarity is cosine on the stored quantized vectors. */
export type VectorHit = Readonly<{ chunkId: string; documentKey: string; distance: number; similarity: number; dimensions: number }>;
export type StoredFact = TemporalFact & Readonly<{ usefulness: number }>;
export type SyncActivity = Readonly<{ turns: number; tokens: number; inserts: number; updatedAt: number }>;
export type SyncRun = Readonly<{
  adapter: string; lastAt: string; at: SyncActivity;
  discovered: number; indexed: number; ok: boolean; detail?: string;
}>;

// Longest query still treated as a possible literal by exactSearch. Above this
// a query is prose, and prose is the lexical and dense legs' job.
const EXACT_SCAN_MAX_CHARS = 64;
const PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 10_000;
// Cap on rows pulled for one fact's evidence, entities or episodes.
const RELATION_LIMIT = 256;
// Most selective query terms kept by lexicalSearch.
const LEXICAL_TERM_LIMIT = 12;
// Terms in more than this share of the corpus are dropped outright. A term that
// appears in most chunks carries almost no bm25 signal — its IDF is near zero —
// but forces the engine to score every chunk it appears in, so it costs
// everything and contributes nothing.
const LEXICAL_DF_CEILING = 0.05;
// Below this the whole index is cheap to scan and the ceiling is skipped: a
// share is meaningless on a small corpus, where a genuinely selective term can
// easily sit above 5% of it.
const LEXICAL_CEILING_MIN_CHUNKS = 5_000;
// The lexical leg never goes silent: if every query term is common, the most
// selective few are used anyway.
const LEXICAL_MIN_TERMS = 3;
// Age past which an orphaned rebuild temporary is assumed abandoned.
const STALE_TEMP_MS = 10 * 60_000;
// Cached term frequencies before the cache is dropped wholesale.
const TERM_CACHE_LIMIT = 20_000;
const DOCUMENT_COLUMNS = 'document_key, namespace, external_id, scope_id, scope_kind, source, kind, title, text, uri,'
  + ' version, content_hash, observed_at, valid_from, valid_to, trust, metadata, source_adapter, source_revision';

type Row = Record<string, SQLInputValue>;
const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const millis = (value?: string): number | null => value ? Date.parse(value) : null;
const iso = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
const vectorBlob = (vector: readonly number[]): Uint8Array => new Uint8Array(Float32Array.from(vector).buffer);
const tableNameFor = (model: string, dims: number): string => `vec_${sha256(`${model}\u0000${dims}`).slice(0, 16)}`;
const vectorTableName = (value: unknown): string => {
  const table = String(value);
  if (!/^vec_[0-9a-f]{16}$/u.test(table)) throw new Error('Invalid vector collection table name.');
  return table;
};

const syncRunFromRow = (row: Row): SyncRun => ({
  adapter: String(row.adapter), lastAt: new Date(Number(row.last_at)).toISOString(),
  at: { turns: Number(row.at_turns), tokens: Number(row.at_tokens), inserts: Number(row.at_inserts), updatedAt: Number(row.last_at) },
  discovered: Number(row.discovered), indexed: Number(row.indexed), ok: Number(row.ok) === 1,
  ...(row.detail ? { detail: String(row.detail) } : {}),
});

const documentFromRow = (row: Row, text: string): SourceDocument => ({
  namespace: String(row.namespace), externalId: String(row.external_id), scopeId: String(row.scope_id),
  scopeKind: String(row.scope_kind) as SourceDocument['scopeKind'], source: String(row.source), kind: String(row.kind),
  ...(row.title ? { title: String(row.title) } : {}), text, ...(row.uri ? { uri: String(row.uri) } : {}),
  version: String(row.version), contentHash: String(row.content_hash), observedAt: new Date(Number(row.observed_at)).toISOString(),
  ...(iso(row.valid_from) ? { validFrom: iso(row.valid_from)! } : {}), ...(iso(row.valid_to) ? { validTo: iso(row.valid_to)! } : {}),
  ...(row.source_adapter ? { sync: { adapter: String(row.source_adapter), revision: String(row.source_revision) } } : {}),
  trust: String(row.trust) as SourceDocument['trust'], metadata: parse<Record<string, string>>(row.metadata, {}),
});

export class Projection {
  readonly path: string;
  readonly db: DatabaseSync;
  private depth = 0;
  private readonly ownsConnection: boolean;
  private readonly statements = new Map<string, StatementSync>();
  private readonly termFrequency = new Map<string, number>();
  private readonly vectorCollections = new Map<string, { key: string; table: string }>();
  private chunks_: number | undefined;
  private lexicalRevision = '';
  private lexicalTokens: number | undefined;

  constructor(pathOrDb: string | DatabaseSync, attachedPath?: string,
    options: { allowCompactPromotion?: boolean; transactionActive?: boolean; maintenanceHeld?: boolean } = {}) {
    this.depth = options.transactionActive ? 1 : 0;
    const releaseMaintenance = typeof pathOrDb === 'string' && !options.maintenanceHeld
      ? (() => { privateDirectorySync(dirname(pathOrDb)); return acquireMaintenanceLock(dirname(pathOrDb)); })() : undefined;
    try {
      if (typeof pathOrDb === 'string') {
        this.path = pathOrDb;
        this.ownsConnection = true;
        privateDirectorySync(dirname(pathOrDb));
        migrateIndexedPath(pathOrDb, true);
        this.db = new DatabaseSync(pathOrDb, { allowExtension: true });
      } else {
        this.path = attachedPath ?? '';
        this.ownsConnection = false;
        this.db = pathOrDb;
      }
      try {
        this.db.exec('PRAGMA busy_timeout=5000');
        const hasCompact = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='compact_authority'").get();
        const compact = hasCompact ? this.db.prepare('SELECT mode FROM compact_authority WHERE id=1').get() as { mode?: number } | undefined : undefined;
        if (compact?.mode === 0 && !options.allowCompactPromotion) {
          throw new Error('Compact memory must be opened through the compact authority.');
        }
        this.db.enableLoadExtension(true);
        try { sqliteVec.load(this.db); } finally { this.db.enableLoadExtension(false); }
        migrate(this.db, compact?.mode === 0 ? { preserveCompactPragmas: true } : {});
        if (this.ownsConnection) privateDatabaseFiles(this.path);
      } catch (error) {
        // Opening leaves an fd and a file lock held; migrate() rejects a schema
        // from a newer build, and that rejection must not leak the handle.
        if (this.ownsConnection) this.db.close();
        throw error;
      }
    } finally { releaseMaintenance?.(); }
  }

  /** Curation shares this one canonical connection; ownership stays here. */
  attachCuration(path: string): CurationStore { return new CurationStore(this.db, path); }
  claimOwner(projectId: string): void { claimMemoryOwner(this.db, projectId); }

  adoptOuter(): void { this.depth += 1; }
  // Transaction control is exposed as named operations so orchestration can
  // depend on the authority port instead of this connection.
  beginImmediate(): void { this.db.exec('BEGIN IMMEDIATE'); }
  commit(): void { this.db.exec('COMMIT'); }
  rollback(): void { this.db.exec('ROLLBACK'); }

  /** Consistent physical copy for an explicit, reversible legacy checkpoint. */
  exportSnapshot(destination: string): void {
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
    this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  }

  releaseOuter(): void { this.depth = Math.max(0, this.depth - 1); }

  // Compiling a statement costs ~11 µs, which is several times the cost of
  // running a point lookup. Every query here has a fixed SQL shape, so they are
  // compiled once per connection and reused.
  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** Daemon backpressure, not an extension-turn hook. A pinned reader cannot be
   * forced to release its snapshot safely, so stop taking jobs rather than grow
   * the WAL indefinitely. One in-flight bounded job may exceed this soft limit.
   */
  walPublicationPaused(): boolean {
    const bytes = statSync(`${this.path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
    if (bytes < MAX_QUIESCENT_WAL_BYTES) return false;
    return this.checkpointWal().status === 'busy';
  }

  /** Explicit quiescent maintenance only. Never called from apply/transaction or hot open.
   * TRUNCATE releases the allocated WAL (PASSIVE alone leaves its high-water size).
   * A pinned reader/writer wins immediately; a later boundary retries without waiting.
   */
  checkpointWal(): { status: 'checkpointed' | 'busy'; logFrames: number; checkpointedFrames: number } {
    if (this.depth > 0) throw new Error('WAL maintenance cannot run inside an authority transaction.');
    const timeout = this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number; busy_timeout?: number };
    const prior = Number(timeout.timeout ?? timeout.busy_timeout ?? 5000);
    this.db.exec('PRAGMA busy_timeout=0');
    try {
      const row = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
        busy: number; log: number; checkpointed: number;
      };
      return { status: row.busy ? 'busy' : 'checkpointed', logFrames: row.log, checkpointedFrames: row.checkpointed };
    } catch (error) {
      if (/locked|busy/iu.test(String(error))) return { status: 'busy', logFrames: -1, checkpointedFrames: -1 };
      throw error;
    } finally {
      this.db.exec(`PRAGMA busy_timeout=${prior}`);
    }
  }

  close(): void {
    this.statements.clear();
    this.termFrequency.clear();
    this.vectorCollections.clear();
    this.chunks_ = undefined;
    if (this.ownsConnection) this.db.close();
  }

  // Re-entrant: a batch caller can wrap many apply() calls, each of which opens
  // its own logical transaction, in one physical transaction. The outermost
  // scope owns the commit, so an inner failure still rolls the whole run back.
  transaction<T>(action: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try { return action(); } finally { this.depth -= 1; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  hasEvent(id: string): boolean {
    return Boolean(this.stmt('SELECT 1 FROM applied_events WHERE id = ?').get(id));
  }

  apply(event: MemoryEvent): boolean {
    if (this.hasEvent(event.id)) return false;
    return this.transaction(() => {
      if (this.hasEvent(event.id)) return false;
      const payload = event.payload;
      if (payload.type === 'document.upserted') this.upsertDocument(payload.document);
      if (payload.type === 'document.deleted') this.deleteDocument(payload.namespace, payload.externalId, event.recordedAt);
      if (payload.type === 'episode.recorded') this.insertEpisode(payload.episode);
      if (payload.type === 'fact.recorded') this.insertFact(payload.fact, event.recordedAt);
      if (payload.type === 'fact.resolved') this.resolveFact(payload.factId, payload.standing, payload.replacementId, event.recordedAt);
      if (payload.type === 'retrieval.feedback') this.feedback(payload.factId, payload.signal, event.recordedAt);
      if (payload.type === 'gc.compacted') {
        for (const key of payload.removed) this.deleteDocumentKey(key, event.recordedAt);
      }
      if (payload.type === 'curation.batch.commit') {
        for (const fact of payload.facts) this.insertFact(fact, event.recordedAt);
        for (const document of payload.documents) this.upsertDocument(document);
        for (const item of payload.resolves ?? []) this.resolveFact(item.factId, item.standing, undefined, event.recordedAt);
      }
      this.stmt('INSERT INTO applied_events(id, event_hash, recorded_at) VALUES (?, ?, ?)')
        .run(event.id, event.eventHash, Date.parse(event.recordedAt));
      return true;
    });
  }

  upsertDocument(document: SourceDocument): void {
    const key = documentKey(document);
    const chunks = document.text.trim() ? chunkDocument(document) : [];
    const chunksCurrent = this.chunksMatch(document, chunks, document.title);
    this.stmt(`INSERT INTO documents(
      document_key, namespace, external_id, scope_id, scope_kind, source, kind, title, text, uri,
      version, content_hash, observed_at, valid_from, valid_to, trust, metadata, source_adapter, source_revision, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(document_key) DO UPDATE SET
      scope_id=excluded.scope_id, scope_kind=excluded.scope_kind, source=excluded.source,
      kind=excluded.kind, title=excluded.title, text=excluded.text, uri=excluded.uri,
      version=excluded.version, content_hash=excluded.content_hash, observed_at=excluded.observed_at,
      valid_from=excluded.valid_from, valid_to=excluded.valid_to, trust=excluded.trust,
      metadata=excluded.metadata, source_adapter=excluded.source_adapter, source_revision=excluded.source_revision, deleted_at=NULL`)
      .run(key, document.namespace, document.externalId, document.scopeId, document.scopeKind,
        document.source, document.kind, document.title ?? null, document.text, document.uri ?? null,
        document.version, document.contentHash, Date.parse(document.observedAt), millis(document.validFrom),
        millis(document.validTo), document.trust, json(document.metadata), document.sync?.adapter ?? null, document.sync?.revision ?? null);
    if (!chunksCurrent) this.replaceChunks(key, chunks, document.title);
  }

  deleteDocument(namespace: string, externalId: string, at: string): void {
    this.deleteDocumentKey(documentKey({ namespace, externalId }), at);
  }

  private deleteDocumentKey(key: string, at: string): void {
    this.deleteChunksForDocument(key);
    this.stmt('UPDATE documents SET deleted_at = ? WHERE document_key = ?').run(Date.parse(at), key);
  }

  replaceChunks(key: string, chunks: readonly DocumentChunk[], title?: string): void {
    if (!chunks.length) {
      this.transaction(() => this.deleteChunksForDocument(key));
      return;
    }
    this.replaceChunksBatch(chunks, title ? new Map([[key, title]]) : undefined);
  }

  replaceChunksBatch(chunks: readonly DocumentChunk[], titles?: ReadonlyMap<string, string>): void {
    this.chunks_ = undefined;
    this.transaction(() => {
      const keys = [...new Set(chunks.map(chunk => chunk.documentKey))];
      for (const key of keys) this.deleteChunksForDocument(key, false);
      const insert = this.stmt('INSERT INTO chunks(id, document_key, namespace, ordinal, title, text, content_hash, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const insertFts = this.stmt('INSERT INTO chunks_fts(rowid, title, text, metadata) VALUES (?, ?, ?, ?)');
      for (const chunk of chunks) {
        const title = titles?.get(chunk.documentKey);
        const inserted = insert.run(chunk.id, chunk.documentKey, chunk.namespace, chunk.ordinal, title ?? null, chunk.text, chunk.contentHash, json(chunk.metadata));
        insertFts.run(inserted.lastInsertRowid, title ?? '', chunk.text, Object.values(chunk.metadata).join(' '));
      }
      this.bumpLexicalGeneration();
    });
  }

  private bumpLexicalGeneration(): void {
    this.stmt("INSERT INTO meta(key,value) VALUES ('lexical_generation','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
  }

  private deleteChunksForDocument(key: string, bump = true): void {
    this.chunks_ = undefined;
    const rows = this.stmt('SELECT id,rowid FROM chunks WHERE document_key = ? LIMIT ?').all(key, MAX_PAGE_SIZE) as Row[];
    for (const row of rows) this.deleteVectorForChunk(String(row.id));
    const removeFts = this.stmt('DELETE FROM chunks_fts WHERE rowid = ?');
    for (const row of rows) removeFts.run(row.rowid!);
    this.stmt('DELETE FROM chunks WHERE document_key = ?').run(key);
    if (bump && rows.length) this.bumpLexicalGeneration();
  }

  private insertEvidence(evidence: EvidenceRef): void {
    this.stmt(`INSERT INTO evidence(id, origin, provenance, uri, content_hash, excerpt, observed_at, actor_id, session_id, tool_call_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(evidence.id, evidence.origin, evidence.provenance, evidence.uri ?? null,
      evidence.contentHash, evidence.excerpt, Date.parse(evidence.observedAt), evidence.actorId ?? null,
      evidence.sessionId ?? null, evidence.toolCallId ?? null);
  }

  private insertEpisode(episode: Episode): void {
    this.stmt(`INSERT INTO episodes(id, scope_id, kind, summary, observed_at, actor_id, session_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(episode.id, episode.scopeId, episode.kind, episode.summary, Date.parse(episode.observedAt),
        episode.actorId ?? null, episode.sessionId ?? null, episode.source);
    for (const evidence of episode.evidence) {
      this.insertEvidence(evidence);
      this.stmt('INSERT OR IGNORE INTO episode_evidence(episode_id, evidence_id) VALUES (?, ?)').run(episode.id, evidence.id);
    }
  }

  private insertEntity(entity: Entity): void {
    this.stmt(`INSERT INTO entities(id, scope_id, name, type, aliases, summary) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, aliases=excluded.aliases,
      summary=COALESCE(excluded.summary, entities.summary)`)
      .run(entity.id, entity.scopeId, entity.name, entity.type, json(entity.aliases), entity.summary ?? null);
  }

  private insertFact(fact: TemporalFact, recordedAt: string): void {
    // Historical duplicate events must not rewrite the mirrored document while
    // ON CONFLICT preserves the original fact. Facts are immutable identities.
    if (this.getFact(fact.id)) return;
    const scopeKind: SourceDocument['scopeKind'] = fact.scopeId === 'shared' ? 'shared' : fact.scopeId.startsWith('p_') ? 'project' : 'team';
    this.upsertDocument({ namespace: 'memory', externalId: fact.id, scopeId: fact.scopeId, scopeKind,
      source: 'pi-memory', kind: fact.kind, title: fact.subject ?? fact.statement.slice(0, 100), text: fact.statement,
      version: sha256(JSON.stringify(fact)), contentHash: sha256(fact.statement), observedAt: fact.recordedAt,
      ...(fact.validAt ? { validFrom: fact.validAt } : {}), ...(fact.invalidAt ? { validTo: fact.invalidAt } : {}),
      trust: fact.evidence.some(item => item.provenance === 'native_observation') ? 'host'
        : fact.evidence.some(item => item.provenance === 'declared') ? 'user' : 'agent', metadata: fact.tags });
    this.stmt(`INSERT INTO facts(id, scope_id, kind, statement, subject, predicate, object, standing,
      confidence, valid_at, invalid_at, recorded_at, expired_at, tags, replacement_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO NOTHING`).run(fact.id, fact.scopeId, fact.kind, fact.statement,
      fact.subject ?? null, fact.predicate ?? null, fact.object ?? null, fact.standing, fact.confidence,
      millis(fact.validAt), millis(fact.invalidAt), Date.parse(fact.recordedAt), millis(fact.expiredAt), json(fact.tags));
    for (const evidence of fact.evidence) {
      this.insertEvidence(evidence);
      this.stmt('INSERT OR IGNORE INTO fact_evidence(fact_id, evidence_id) VALUES (?, ?)').run(fact.id, evidence.id);
    }
    for (const entity of fact.entities) {
      this.insertEntity(entity);
      this.stmt('INSERT OR IGNORE INTO fact_entities(fact_id, entity_id) VALUES (?, ?)').run(fact.id, entity.id);
    }
    for (const episodeId of fact.episodeIds) this.stmt('INSERT OR IGNORE INTO fact_episodes(fact_id, episode_id) VALUES (?, ?)').run(fact.id, episodeId);
    for (const replaced of fact.supersedes ?? []) {
      this.stmt("INSERT OR IGNORE INTO fact_links(from_fact_id, to_fact_id, relation) VALUES (?, ?, 'supersedes')").run(fact.id, replaced);
      this.resolveFact(replaced, 'superseded', fact.id, recordedAt, fact.validAt ?? fact.recordedAt);
    }
  }

  private resolveFact(id: string, standing: MemoryStanding, replacementId: string | undefined, at: string, effectiveAt = at): void {
    const fact = this.getFact(id);
    if (!fact) return;
    const terminal = ['superseded', 'contradicted'].includes(standing);
    if (!terminal && ['superseded', 'contradicted'].includes(fact.standing)) return;
    // valid time is the replacement's effective date; transaction time is the
    // journal event. Cancelling a planned fact leaves an empty, not inverted,
    // interval. Repeated resolution cannot postpone its original cutoff/GC.
    const cutoff = Math.max(Date.parse(fact.validAt ?? fact.recordedAt),
      Math.min(Date.parse(effectiveAt), fact.invalidAt ? Date.parse(fact.invalidAt) : Infinity));
    this.stmt(`UPDATE facts SET standing=?, replacement_id=COALESCE(?, replacement_id),
      expired_at=CASE WHEN ?=1 THEN COALESCE(expired_at, ?) ELSE expired_at END,
      invalid_at=CASE WHEN ?=1 THEN ? ELSE invalid_at END WHERE id=?`)
      .run(standing, replacementId ?? null, terminal ? 1 : 0, Date.parse(at), terminal ? 1 : 0, cutoff, id);
    if (terminal) this.stmt("UPDATE documents SET valid_to=? WHERE namespace='memory' AND external_id=?").run(cutoff, id);
    if (replacementId) this.stmt("INSERT OR IGNORE INTO fact_links(from_fact_id, to_fact_id, relation) VALUES (?, ?, 'resolves')").run(replacementId, id);
  }

  private feedback(id: string, signal: 'used' | 'helpful' | 'wrong' | 'stale', at: string): void {
    const column = signal;
    this.stmt(`INSERT INTO usefulness(fact_id, ${column}, last_signal_at) VALUES (?, 1, ?)
      ON CONFLICT(fact_id) DO UPDATE SET ${column}=${column}+1, last_signal_at=excluded.last_signal_at`)
      .run(id, Date.parse(at));
  }

  private vectorCollection(model: string, dims: number): { key: string; table: string } | undefined {
    if (!Number.isSafeInteger(dims) || dims < 8 || dims > 8192) throw new Error('Invalid embedding dimensions.');
    const key = sha256(`${model}\u0000${dims}`);
    const cached = this.vectorCollections.get(key);
    if (cached) return cached;
    const row = this.stmt('SELECT table_name FROM vector_collections WHERE model_key=? AND active=1 LIMIT 1').get(key) as Row | undefined;
    if (!row) return undefined;
    const found = { key, table: vectorTableName(row.table_name) };
    this.vectorCollections.set(key, found);
    return found;
  }

  ensureVectorCollection(model: string, dims: number): { key: string; table: string } {
    const existing = this.vectorCollection(model, dims);
    if (existing) return existing;
    const key = sha256(`${model}\u0000${dims}`);
    const table = tableNameFor(model, dims);
    // Unit-normalized provider vectors are scalar-quantized by sqlite-vec to
    // int8: four times less disk and memory than float32 with the same shape.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding int8[${dims}])`);
    this.stmt(`INSERT INTO vector_collections(model_key, model, dims, table_name, created_at, active)
      VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(model_key) DO UPDATE SET active=1`)
      .run(key, model, dims, table, Date.now());
    const created = { key, table };
    this.vectorCollections.set(key, created);
    return created;
  }

  storeVector(chunkId: string, model: string, vector: readonly number[]): void {
    this.storeVectors([{ chunkId, vector }], model);
  }

  hasVector(chunkId: string, model: string): boolean {
    return this.stmt(`SELECT 1 FROM vector_map vm JOIN vector_collections vc ON vc.model_key=vm.model_key
      WHERE vm.chunk_id=? AND vc.model=? AND vc.active=1 LIMIT 1`).get(chunkId, model) !== undefined;
  }

  storeVectors(rows: readonly { chunkId: string; vector: readonly number[] }[], model: string): void {
    if (!rows.length) return;
    const dims = rows[0]!.vector.length;
    if (rows.some(row => row.vector.length !== dims)) throw new Error('Embedding batch dimensions differ.');
    if (rows.some(row => row.vector.some(value => !Number.isFinite(value)))) throw new Error('Embedding vectors must be finite.');
    const collection = this.ensureVectorCollection(model, dims);
    this.transaction(() => {
      const find = this.stmt('SELECT rowid FROM vector_map WHERE chunk_id = ? AND model_key = ?');
      const addMap = this.stmt('INSERT INTO vector_map(chunk_id, model_key) VALUES (?, ?)');
      const addVector = this.stmt(`INSERT INTO ${collection.table}(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))`);
      const removeVector = this.stmt(`DELETE FROM ${collection.table} WHERE rowid = ?`);
      for (const item of rows) {
        const prior = find.get(item.chunkId, collection.key) as Row | undefined;
        if (prior) removeVector.run(prior.rowid!);
        if (!prior) addMap.run(item.chunkId, collection.key);
        const row = find.get(item.chunkId, collection.key) as Row;
        // sqlite-vec's vec0 primary key binding requires a BigInt through
        // node:sqlite even though the mapping table exposes a safe number.
        addVector.run(BigInt(Number(row.rowid)), vectorBlob(item.vector));
      }
    });
  }

  private deleteVectorForChunk(chunkId: string): void {
    const rows = this.stmt(`SELECT vm.rowid, vc.table_name FROM vector_map vm
      JOIN vector_collections vc ON vc.model_key=vm.model_key WHERE vm.chunk_id=? LIMIT ?`).all(chunkId, RELATION_LIMIT) as Row[];
    for (const row of rows) this.stmt(`DELETE FROM ${vectorTableName(row.table_name)} WHERE rowid = ?`).run(row.rowid!);
    this.stmt('DELETE FROM vector_map WHERE chunk_id = ?').run(chunkId);
  }

  // None of the three search legs joins `documents` any more. Soft-deleting a
  // document runs deleteChunksForDocument, which physically removes its chunks,
  // its FTS rows and its vectors — so a `d.deleted_at IS NULL` filter could
  // never exclude anything, and the join was pure cost: four tables deep on the
  // dense leg, three on the lexical one.
  vectorSearch(model: string, dims: number, vector: readonly number[], limit: number): VectorHit[] {
    if (vector.some(value => !Number.isFinite(value))) throw new Error('Embedding query must be finite.');
    const collection = this.vectorCollection(model, dims);
    if (!collection) return [];
    const rows = this.stmt(`SELECT v.distance, vm.chunk_id, c.document_key,
      1 - vec_distance_cosine(v.embedding, vec_quantize_int8(?, 'unit')) AS similarity
      FROM ${collection.table} v
      JOIN vector_map vm ON vm.rowid=v.rowid AND vm.model_key=?
      JOIN chunks c ON c.id=vm.chunk_id
      WHERE v.embedding MATCH vec_quantize_int8(?, 'unit') AND k=?
      ORDER BY v.distance`).all(vectorBlob(vector), collection.key, vectorBlob(vector), Math.max(1, Math.min(1000, limit))) as Row[];
    return rows.map(row => ({ chunkId: String(row.chunk_id), documentKey: String(row.document_key), distance: Number(row.distance),
      dimensions: dims, similarity: typeof row.similarity === 'number' && Number.isFinite(row.similarity) ? Math.max(-1, Math.min(1, row.similarity)) : 0 }));
  }

  // Keeps the most selective terms of a query and discards the rest. OR-ing
  // every token of a prose prompt makes FTS5 bm25-score most of the corpus
  // before the limit applies, so cost grew with corpus size while the extra
  // terms — the ones in almost every document — carried almost no signal.
  /** Chunk count, cached because it gates every lexical query. */
  private chunkTotal(): number {
    if (this.chunks_ === undefined) this.chunks_ = Number((this.stmt('SELECT count(*) AS n FROM chunks').get() as Row).n);
    return this.chunks_;
  }

  private documentFrequencies(terms: readonly string[]): Map<string, number> {
    // fts5vocab has no index of its own, so asking it about a term is not a
    // seek. Frequencies are cached per connection: they only decide which terms
    // to keep, so drifting slightly behind new writes costs nothing but a
    // marginally worse choice, and vocabulary repeats heavily across prompts.
    const missing = terms.filter(term => !this.termFrequency.has(term));
    if (missing.length) {
      const rows = this.stmt(`SELECT term, doc FROM chunks_fts_vocab WHERE term IN (${missing.map(() => '?').join(',')})`)
        .all(...missing) as Row[];
      const found = new Map(rows.map(row => [String(row.term), Number(row.doc)]));
      if (this.termFrequency.size + missing.length > TERM_CACHE_LIMIT) this.termFrequency.clear();
      // A term absent from the vocabulary matches nothing, which is maximally
      // selective, so it records as 0 and sorts first.
      for (const term of missing) this.termFrequency.set(term, found.get(term) ?? 0);
    }
    return new Map(terms.map(term => [term, this.termFrequency.get(term) ?? 0]));
  }

  /** Full-corpus statistics, not statistics of a query-selected candidate pool. */
  lexicalStatistics(terms: readonly string[]): { documents: number; tokens: number; frequencies: ReadonlyMap<string, number> } {
    const revision = `${String((this.stmt('PRAGMA data_version').get() as Row).data_version)}:${String((this.stmt("SELECT value FROM meta WHERE key='lexical_generation'").get() as Row | undefined)?.value ?? '0')}`;
    if (revision !== this.lexicalRevision) {
      this.lexicalRevision = revision;
      this.lexicalTokens = undefined;
      this.chunks_ = undefined;
      this.termFrequency.clear();
    }
    if (this.lexicalTokens === undefined) this.lexicalTokens = Number((this.stmt('SELECT coalesce(sum(cnt),0) AS n FROM chunks_fts_vocab').get() as Row).n);
    return { documents: this.chunkTotal(), tokens: this.lexicalTokens, frequencies: this.documentFrequencies(terms) };
  }

  selectiveTerms(tokens: readonly string[]): string[] {
    const unique = [...new Set(tokens)];
    if (unique.length <= LEXICAL_MIN_TERMS) return unique;
    const counts = this.documentFrequencies(unique);
    const ranked = [...unique].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0));
    const total = this.chunkTotal();
    // Taking "the twelve most selective" is not enough on its own: when a query
    // has only a handful of rare words the rest of the twelve are filler that
    // each match most of the corpus, and one such term is enough to make bm25
    // score everything.
    const ceiling = total >= LEXICAL_CEILING_MIN_CHUNKS ? total * LEXICAL_DF_CEILING : Number.POSITIVE_INFINITY;
    const informative = ranked.filter(term => (counts.get(term) ?? 0) <= ceiling);
    const chosen = informative.length >= LEXICAL_MIN_TERMS ? informative : ranked.slice(0, LEXICAL_MIN_TERMS);
    return chosen.slice(0, LEXICAL_TERM_LIMIT);
  }

  // Ranking happens inside a subquery over chunks_fts alone. Scoring the match
  // set after joining chunks made SQLite bm25-score and sort every joined row
  // before applying the limit.
  lexicalSearch(query: string, limit: number): LexicalHit[] {
    const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? [];
    if (!tokens.length) return [];
    const expression = this.selectiveTerms(tokens.slice(0, 64)).map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
    if (!expression) return [];
    const capped = Math.max(1, Math.min(1000, limit));
    const rows = this.stmt(`SELECT c.id AS chunk_id, m.rank, c.document_key FROM (
        SELECT f.rowid AS chunk_rowid, bm25(chunks_fts, 8.0, 2.0, 1.0) AS rank
        FROM chunks_fts f WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?
      ) m JOIN chunks c ON c.rowid=m.chunk_rowid ORDER BY m.rank LIMIT ?`).all(expression, capped, capped) as Row[];
    return rows.map(row => ({ chunkId: String(row.chunk_id), documentKey: String(row.document_key), score: 1 / (1 + Math.abs(Number(row.rank))) }));
  }

  // The substring leg is an unindexed scan of every chunk, so it is reserved for
  // queries short enough to plausibly BE a literal — an identifier, a path, a
  // quoted phrase. Running it with a whole natural-language prompt as the
  // pattern scanned the entire corpus on every turn and essentially never
  // matched; that made query latency grow linearly with corpus size.
  exactSearch(query: string, limit: number): LexicalHit[] {
    const capped = Math.max(1, Math.min(1000, limit));
    // Two indexed point lookups instead of an OR across a join: the OR forced a
    // scan, and external_id had no usable index of its own.
    const byChunk = this.stmt('SELECT id AS chunk_id, document_key FROM chunks WHERE id=? LIMIT 1').all(query) as Row[];
    const byDocument = this.stmt(`SELECT c.id AS chunk_id, c.document_key FROM documents d
      JOIN chunks c ON c.document_key=d.document_key
      WHERE d.external_id=? AND d.deleted_at IS NULL LIMIT ?`).all(query, capped) as Row[];
    const literal = query.length <= EXACT_SCAN_MAX_CHARS ? this.literalScan(query, capped) : [];
    const rows = [...byChunk, ...byDocument, ...literal];
    const seen = new Set<string>();
    return rows.flatMap(row => {
      const chunkId = String(row.chunk_id);
      if (seen.has(chunkId)) return [];
      seen.add(chunkId);
      return [{ chunkId, documentKey: String(row.document_key), score: 1 }];
    }).slice(0, limit);
  }

  private literalScan(query: string, limit: number): Row[] {
    const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    const inText = this.stmt(`SELECT id AS chunk_id, document_key FROM chunks
      WHERE text LIKE ? ESCAPE '\\' LIMIT ?`).all(`%${escaped}%`, limit) as Row[];
    const inUri = this.stmt(`SELECT c.id AS chunk_id, c.document_key FROM documents d
      JOIN chunks c ON c.document_key=d.document_key
      WHERE d.uri LIKE ? ESCAPE '\\' AND d.deleted_at IS NULL LIMIT ?`).all(`%${escaped}%`, limit) as Row[];
    return [...inText, ...inUri];
  }

  /** Small-to-large retrieval: carry the continuation of a selected heading or paragraph. */
  chunkWindow(chunkId: string, maxChars = 2400): { text: string; chunkIds: string[] } | undefined {
    const first = this.stmt('SELECT document_key, ordinal FROM chunks WHERE id=?').get(chunkId) as Row | undefined;
    if (!first) return undefined;
    const rows = this.stmt('SELECT id, text FROM chunks WHERE document_key=? AND ordinal>=? ORDER BY ordinal LIMIT 3')
      .all(first.document_key!, first.ordinal!) as Row[];
    return rows.reduce<{ text: string; chunkIds: string[] }>((window, row) => {
      if (window.text.length >= maxChars) return window;
      const next = `${window.text ? '\n\n' : ''}${String(row.text)}`;
      return { text: `${window.text}${next}`.slice(0, maxChars), chunkIds: [...window.chunkIds, String(row.id)] };
    }, { text: '', chunkIds: [] });
  }

  chunksMatch(document: Pick<SourceDocument, 'namespace' | 'externalId'>, chunks: readonly DocumentChunk[], title?: string): boolean {
    const rows = this.stmt('SELECT id,title,metadata FROM chunks WHERE document_key=? ORDER BY ordinal').all(documentKey(document)) as Row[];
    return rows.length === chunks.length && rows.every((row, index) => row.id === chunks[index]?.id
      && (row.title ?? undefined) === title && row.metadata === json(chunks[index]?.metadata ?? {}));
  }

  chunkIds(document: Pick<SourceDocument, 'namespace' | 'externalId'>): string[] {
    return (this.stmt('SELECT id FROM chunks WHERE document_key=? ORDER BY ordinal').all(documentKey(document)) as Row[])
      .map(row => String(row.id));
  }

  chunkCount(document: Pick<SourceDocument, 'namespace' | 'externalId'>): number {
    return this.chunkIds(document).length;
  }

  unembeddedChunks(model: string): Array<DocumentChunk & { document: SourceDocument }> {
    const rows = this.stmt(`SELECT c.id FROM chunks c
      JOIN documents d ON d.document_key=c.document_key
      WHERE d.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM vector_map vm JOIN vector_collections vc ON vc.model_key=vm.model_key
        WHERE vm.chunk_id=c.id AND vc.model=?
      ) ORDER BY c.id LIMIT ?`).all(model, MAX_PAGE_SIZE) as Row[];
    return this.chunks(rows.map(row => String(row.id)));
  }

  chunks(ids: readonly string[]): Array<DocumentChunk & { document: SourceDocument }> { return this.chunksById(ids, true); }
  retrievalChunks(ids: readonly string[]): Array<DocumentChunk & { document: SourceDocument }> { return this.chunksById(ids, false); }

  private chunksById(ids: readonly string[], includeDocumentText: boolean): Array<DocumentChunk & { document: SourceDocument }> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const documentText = includeDocumentText ? 'd.text' : "''";
    const rows = this.stmt(`SELECT c.id AS chunk_id, c.document_key AS chunk_document_key, c.namespace AS chunk_namespace,
      c.ordinal AS chunk_ordinal, c.text AS chunk_text, c.content_hash AS chunk_hash, c.metadata AS chunk_metadata,
      d.namespace, d.external_id, d.scope_id, d.scope_kind, d.source, d.kind, d.title, ${documentText} AS document_text,
      d.uri, d.version, d.content_hash, d.observed_at, d.valid_from, d.valid_to, d.trust, d.metadata, d.source_adapter, d.source_revision
      FROM chunks c JOIN documents d ON d.document_key=c.document_key WHERE c.id IN (${placeholders})`).all(...ids) as Row[];
    const byId = new Map(rows.map(row => [String(row.chunk_id), row]));
    return ids.flatMap(id => {
      const row = byId.get(id);
      if (!row) return [];
      const document = documentFromRow(row, String(row.document_text));
      return [{ id, documentKey: String(row.chunk_document_key), namespace: String(row.chunk_namespace), ordinal: Number(row.chunk_ordinal),
        text: String(row.chunk_text), contentHash: String(row.chunk_hash), metadata: parse<Record<string, string>>(row.chunk_metadata, {}), document }];
    });
  }

  getFacts(ids: readonly string[]): StoredFact[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.stmt(`SELECT f.id,f.scope_id,f.kind,f.statement,f.subject,f.predicate,f.object,f.standing,
      f.confidence,f.valid_at,f.invalid_at,f.recorded_at,f.expired_at,f.tags,f.replacement_id,
      COALESCE(u.used + 2*u.helpful - 3*u.wrong - 2*u.stale,0) AS utility
      FROM facts f LEFT JOIN usefulness u ON u.fact_id=f.id WHERE f.id IN (${placeholders})`).all(...ids) as Row[];
    const evidenceRows = this.stmt(`SELECT fe.fact_id,e.id,e.origin,e.provenance,e.uri,e.content_hash,e.excerpt,
      e.observed_at,e.actor_id,e.session_id,e.tool_call_id FROM fact_evidence fe JOIN evidence e ON e.id=fe.evidence_id
      WHERE fe.fact_id IN (${placeholders})`).all(...ids) as Row[];
    const entityRows = this.stmt(`SELECT fe.fact_id,e.id,e.scope_id,e.name,e.type,e.aliases,e.summary
      FROM fact_entities fe JOIN entities e ON e.id=fe.entity_id WHERE fe.fact_id IN (${placeholders})`).all(...ids) as Row[];
    const supersededRows = this.stmt(`SELECT from_fact_id,to_fact_id FROM fact_links
      WHERE relation='supersedes' AND from_fact_id IN (${placeholders}) ORDER BY to_fact_id`).all(...ids) as Row[];
    const episodeRows = this.stmt(`SELECT fact_id,episode_id FROM fact_episodes WHERE fact_id IN (${placeholders})`).all(...ids) as Row[];
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return ids.flatMap(id => {
      const row = byId.get(id);
      if (!row) return [];
      const evidence = evidenceRows.filter(item => item.fact_id === id).slice(0, RELATION_LIMIT);
      const entities = entityRows.filter(item => item.fact_id === id).slice(0, RELATION_LIMIT);
      const superseded = supersededRows.filter(item => item.from_fact_id === id).slice(0, RELATION_LIMIT);
      const episodes = episodeRows.filter(item => item.fact_id === id).slice(0, RELATION_LIMIT);
      return [{
        id, scopeId: String(row.scope_id), kind: String(row.kind) as StoredFact['kind'], statement: String(row.statement),
        ...(row.subject ? { subject: String(row.subject) } : {}), ...(row.predicate ? { predicate: String(row.predicate) } : {}),
        ...(row.object ? { object: String(row.object) } : {}), standing: String(row.standing) as StoredFact['standing'],
        confidence: Number(row.confidence), ...(iso(row.valid_at) ? { validAt: iso(row.valid_at)! } : {}),
        ...(iso(row.invalid_at) ? { invalidAt: iso(row.invalid_at)! } : {}), recordedAt: new Date(Number(row.recorded_at)).toISOString(),
        ...(iso(row.expired_at) ? { expiredAt: iso(row.expired_at)! } : {}), tags: parse<Record<string, string>>(row.tags, {}),
        entities: entities.map(entity => ({ id: String(entity.id), scopeId: String(entity.scope_id), name: String(entity.name),
          type: String(entity.type), aliases: parse<string[]>(entity.aliases, []), ...(entity.summary ? { summary: String(entity.summary) } : {}) })),
        evidence: evidence.map(item => ({ id: String(item.id), origin: String(item.origin) as EvidenceRef['origin'],
          provenance: String(item.provenance) as EvidenceRef['provenance'], ...(item.uri ? { uri: String(item.uri) } : {}),
          contentHash: String(item.content_hash), excerpt: String(item.excerpt), observedAt: new Date(Number(item.observed_at)).toISOString(),
          ...(item.actor_id ? { actorId: String(item.actor_id) } : {}), ...(item.session_id ? { sessionId: String(item.session_id) } : {}),
          ...(item.tool_call_id ? { toolCallId: String(item.tool_call_id) } : {}) })),
        episodeIds: episodes.map(episode => String(episode.episode_id)),
        ...(superseded.length ? { supersedes: superseded.map(link => String(link.to_fact_id)) } : {}), usefulness: Number(row.utility),
      }];
    });
  }

  getFact(id: string): StoredFact | undefined { return this.getFacts([id])[0]; }

  graphNeighbors(factIds: readonly string[], limit: number): StoredFact[] {
    if (!factIds.length) return [];
    const placeholders = factIds.map(() => '?').join(',');
    const rows = this.stmt(`SELECT DISTINCT f2.id FROM fact_entities a
      JOIN fact_entities b ON b.entity_id=a.entity_id AND b.fact_id<>a.fact_id
      JOIN facts f2 ON f2.id=b.fact_id
      JOIN documents d ON d.namespace='memory' AND d.external_id=f2.id AND d.deleted_at IS NULL
      WHERE a.fact_id IN (${placeholders})
      ORDER BY f2.recorded_at DESC LIMIT ?`).all(...factIds, limit) as Row[];
    return this.getFacts(rows.map(row => String(row.id)));
  }

  activeFacts(scopeId: string, limit = PAGE_SIZE): StoredFact[] {
    const rows = this.stmt(`SELECT id FROM facts WHERE scope_id=? AND standing IN ('supported','needs_review','candidate')
      ORDER BY recorded_at DESC LIMIT ?`).all(scopeId, Math.max(1, Math.min(MAX_PAGE_SIZE, limit))) as Row[];
    return this.getFacts(rows.map(row => String(row.id)));
  }

  // Keyset-paginated and column-explicit. This used to be an unbounded
  // `SELECT *` that materialized every row, full text included, for callers
  // that only ever streamed over it. Use eachActiveDocument() to walk them all.
  activeDocuments(options: { limit?: number; after?: string } = {}): SourceDocument[] {
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, options.limit ?? PAGE_SIZE));
    const rows = (options.after === undefined
      ? this.stmt(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE deleted_at IS NULL ORDER BY document_key LIMIT ?`).all(limit)
      : this.stmt(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE deleted_at IS NULL AND document_key > ?
          ORDER BY document_key LIMIT ?`).all(options.after, limit)) as Row[];
    return rows.map(row => documentFromRow(row, String(row.text)));
  }

  *eachActiveDocument(batch = PAGE_SIZE): Generator<SourceDocument> {
    const cursor: { after?: string } = {};
    for (;;) {
      const page = this.activeDocuments({ limit: batch, ...(cursor.after === undefined ? {} : { after: cursor.after }) });
      for (const document of page) yield document;
      if (page.length < batch) return;
      cursor.after = documentKey(page[page.length - 1]!);
    }
  }

  // Compact fingerprints instead of the whole row: a source sync only needs to know
  // which keys changed, not to load the corpus it is about to compare against.
  *eachDocumentHash(batch = PAGE_SIZE): Generator<{ documentKey: string; contentHash: string; adapter?: string; revision?: string }> {
    const cursor: { after?: string } = {};
    for (;;) {
      const rows = (cursor.after === undefined
        ? this.stmt('SELECT document_key, content_hash, source_adapter, source_revision FROM documents WHERE deleted_at IS NULL ORDER BY document_key LIMIT ?').all(batch)
        : this.stmt(`SELECT document_key, content_hash, source_adapter, source_revision FROM documents WHERE deleted_at IS NULL AND document_key > ?
            ORDER BY document_key LIMIT ?`).all(cursor.after, batch)) as Row[];
      for (const row of rows) yield { documentKey: String(row.document_key), contentHash: String(row.content_hash),
        ...(row.source_adapter ? { adapter: String(row.source_adapter), revision: String(row.source_revision) } : {}) };
      if (rows.length < batch) return;
      cursor.after = String(rows[rows.length - 1]!.document_key);
    }
  }

  // Point lookup on the documents primary key. The write path used to call
  // activeDocuments() and scan for one row, which made every upsert O(n) in the
  // size of the whole corpus.
  documentByKey(document: Pick<SourceDocument, 'namespace' | 'externalId'>): SourceDocument | undefined {
    const row = this.stmt(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE document_key=? AND deleted_at IS NULL LIMIT 1`)
      .get(documentKey(document)) as Row | undefined;
    return row ? documentFromRow(row, String(row.text)) : undefined;
  }

  // Sync bookkeeping. It lives in the projection rather than the journal
  // because it is operational, not knowledge: losing it to a rebuild costs one
  // extra sync and nothing else.
  activity(): SyncActivity {
    const row = this.stmt('SELECT turns, tokens, inserts, updated_at FROM sync_activity WHERE id = 1').get() as Row | undefined;
    return { turns: Number(row?.turns ?? 0), tokens: Number(row?.tokens ?? 0), inserts: Number(row?.inserts ?? 0),
      updatedAt: Number(row?.updated_at ?? 0) };
  }

  recordActivity(delta: Readonly<{ turns?: number; tokens?: number; inserts?: number }>, at = Date.now()): SyncActivity {
    const turns = Math.max(0, Math.trunc(delta.turns ?? 0));
    const tokens = Math.max(0, Math.trunc(delta.tokens ?? 0));
    const inserts = Math.max(0, Math.trunc(delta.inserts ?? 0));
    if (turns || tokens || inserts) {
      this.stmt(`INSERT INTO sync_activity(id, turns, tokens, inserts, updated_at) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET turns = turns + excluded.turns, tokens = tokens + excluded.tokens,
        inserts = inserts + excluded.inserts, updated_at = excluded.updated_at`).run(turns, tokens, inserts, at);
    }
    return this.activity();
  }

  sourceGaps(): string[] {
    const rows = this.stmt(`SELECT DISTINCT d.source_adapter AS adapter FROM documents d
      LEFT JOIN sync_state s ON s.adapter=d.source_adapter
      WHERE d.source_adapter IS NOT NULL AND d.deleted_at IS NULL AND (s.adapter IS NULL OR s.ok=0) LIMIT ?`).all(PAGE_SIZE) as Row[];
    return rows.map(row => `Source ${String(row.adapter)} could not be fully checked; retained content may be stale.`);
  }

  syncState(adapter: string): SyncRun | undefined {
    const row = this.stmt(`SELECT adapter, last_at, at_turns, at_tokens, at_inserts, discovered, indexed, ok, detail
      FROM sync_state WHERE adapter = ? LIMIT 1`).get(adapter) as Row | undefined;
    return row ? syncRunFromRow(row) : undefined;
  }

  syncStates(limit = PAGE_SIZE): SyncRun[] {
    const rows = this.stmt(`SELECT adapter, last_at, at_turns, at_tokens, at_inserts, discovered, indexed, ok, detail
      FROM sync_state ORDER BY adapter LIMIT ?`).all(Math.max(1, Math.min(MAX_PAGE_SIZE, limit))) as Row[];
    return rows.map(syncRunFromRow);
  }

  recordSync(adapter: string, run: Readonly<{ at?: number; discovered: number; indexed: number; ok: boolean; detail?: string }>): SyncRun {
    const mark = this.activity();
    this.stmt(`INSERT INTO sync_state(adapter, last_at, at_turns, at_tokens, at_inserts, discovered, indexed, ok, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adapter) DO UPDATE SET last_at=excluded.last_at, at_turns=excluded.at_turns,
      at_tokens=excluded.at_tokens, at_inserts=excluded.at_inserts, discovered=excluded.discovered,
      indexed=excluded.indexed, ok=excluded.ok, detail=excluded.detail`)
      .run(adapter, run.at ?? Date.now(), mark.turns, mark.tokens, mark.inserts,
        run.discovered, run.indexed, run.ok ? 1 : 0, run.detail ?? null);
    return this.syncState(adapter)!;
  }

  private assertOperationalOwner(projectId: string): void {
    const row = this.stmt('SELECT project_id FROM memory_owner LIMIT 1').get() as Row | undefined;
    if (typeof row?.project_id !== 'string' || row.project_id !== projectId) {
      throw new Error('Operational checkpoint projectId does not own this memory database.');
    }
  }

  operationalCheckpoint(projectId: string, sessionId: string): string | undefined {
    this.assertOperationalOwner(projectId);
    const row = this.stmt(`SELECT body FROM operational_checkpoints
      WHERE project_id=? AND session_id=? LIMIT 1`).get(projectId, sessionId) as Row | undefined;
    return typeof row?.body === 'string' ? row.body : undefined;
  }

  upsertOperationalCheckpoint(projectId: string, sessionId: string, body: string, updatedAt: number): boolean {
    this.assertOperationalOwner(projectId);
    const result = this.transaction(() => this.stmt(`INSERT INTO operational_checkpoints(project_id, session_id, body, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id, session_id) DO UPDATE SET
      body=excluded.body, updated_at=excluded.updated_at
      WHERE excluded.updated_at >= operational_checkpoints.updated_at`).run(projectId, sessionId, body, updatedAt));
    return Number(result.changes) > 0;
  }

  stats(): { documents: number; chunks: number; vectors: number; facts: number; events: number; bytes: number } {
    const count = (table: string): number => Number((this.stmt(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
    const pageCount = Number((this.stmt('PRAGMA page_count').get() as Row).page_count);
    const pageSize = Number((this.stmt('PRAGMA page_size').get() as Row).page_size);
    return { documents: count('documents'), chunks: count('chunks'), vectors: count('vector_map'), facts: count('facts'), events: count('applied_events'), bytes: pageCount * pageSize };
  }

  gcCandidates(now = Date.now()): string[] {
    const rows = this.stmt(`SELECT d.document_key, d.namespace, f.standing, f.recorded_at,
      COALESCE(u.used + u.helpful, 0) AS positive
      FROM documents d LEFT JOIN facts f ON d.namespace='memory' AND f.id=d.external_id
      LEFT JOIN usefulness u ON u.fact_id=f.id
      WHERE d.deleted_at IS NOT NULL
         OR (d.namespace='memory' AND f.standing IN ('superseded','contradicted')
           AND MAX(COALESCE(f.expired_at, f.recorded_at), COALESCE(f.invalid_at, f.recorded_at)) < ?)
         OR (d.namespace='memory' AND f.standing IN ('candidate','needs_review') AND COALESCE(u.used + u.helpful, 0)=0 AND f.recorded_at < ?)
      LIMIT ?`)
      .all(now - 7 * 86_400_000, now - 30 * 86_400_000, MAX_PAGE_SIZE) as Row[];
    return rows.map(row => String(row.document_key));
  }

  gcProjection(reachableDocumentKeys: ReadonlySet<string>, activeModel?: string): string[] {
    const rows = this.stmt('SELECT document_key FROM documents WHERE deleted_at IS NOT NULL LIMIT ?').all(MAX_PAGE_SIZE) as Row[];
    const removable = rows.map(row => String(row.document_key)).filter(key => !reachableDocumentKeys.has(key));
    this.transaction(() => {
      for (const key of removable) {
        this.deleteChunksForDocument(key);
        this.stmt('DELETE FROM documents WHERE document_key=?').run(key);
      }
      if (activeModel) {
        const stale = this.stmt('SELECT model_key, table_name FROM vector_collections WHERE model<>? LIMIT ?').all(activeModel, RELATION_LIMIT) as Row[];
        for (const collection of stale) {
          this.db.exec(`DROP TABLE IF EXISTS ${vectorTableName(collection.table_name)}`);
          this.stmt('DELETE FROM vector_map WHERE model_key=?').run(collection.model_key!);
          this.stmt('DELETE FROM vector_collections WHERE model_key=?').run(collection.model_key!);
          this.vectorCollections.delete(String(collection.model_key));
        }
      }
      this.db.exec('PRAGMA incremental_vacuum(200)');
    });
    return removable;
  }

  // Sweeps temporaries left behind by a rebuild that crashed. The name carries
  // the pid that created it, and only that pid used to clean it, so a crash
  // orphaned the file permanently. Recently touched files are left alone: the
  // rebuild lock is advisory, so a sibling process may legitimately be writing
  // one right now.
  static discardStaleRebuilds(path: string, olderThanMs = STALE_TEMP_MS): number {
    const directory = dirname(path);
    const prefix = `${basename(path)}.rebuild-`;
    const cutoff = Date.now() - olderThanMs;
    const stale = readdirSync(directory)
      .filter(name => name.startsWith(prefix) && name !== `${basename(path)}.rebuild-${process.pid}`)
      .filter(name => (statSync(join(directory, name), { throwIfNoEntry: false })?.mtimeMs ?? 0) < cutoff);
    for (const name of stale) rmSync(join(directory, name), { force: true });
    return stale.length;
  }

  static rebuild(path: string, events: readonly MemoryEvent[]): Projection {
    const releaseMaintenance = acquireMaintenanceLock(dirname(path));
    try {
      Projection.discardStaleRebuilds(path);
      const temporary = `${path}.rebuild-${process.pid}`;
      const scrub = (target: string): void => {
        rmSync(target, { force: true });
        rmSync(`${target}-wal`, { force: true });
        rmSync(`${target}-shm`, { force: true });
      };
      scrub(temporary);
      const projection = new Projection(temporary, undefined, { maintenanceHeld: true });
      try {
        for (const event of events) projection.apply(event);
      } catch (error) {
        // close() can throw in its own right; that must not mask the real failure
        // or skip the cleanup, which is what a bare second close() in the catch
        // used to do.
        try { projection.close(); } catch { /* the original error is the one that matters */ }
        scrub(temporary);
        throw error;
      }
      projection.close();
      // rename() replaces the destination atomically, so the old file is never
      // unlinked first. Deleting it beforehand left a window in which the scope
      // had no projection at all.
      renameSync(temporary, path);
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${temporary}-wal`, { force: true });
      rmSync(`${temporary}-shm`, { force: true });
      return new Projection(path, undefined, { maintenanceHeld: true });
    } finally { releaseMaintenance(); }
  }
}
