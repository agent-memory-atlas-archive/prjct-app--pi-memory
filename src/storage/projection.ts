import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { DocumentChunk, SourceDocument } from '../contracts/documents.ts';
import { documentKey } from '../contracts/documents.ts';
import type { EvidenceRef } from '../contracts/evidence.ts';
import type { MemoryEvent } from '../contracts/events.ts';
import type { Entity, Episode, MemoryStanding, TemporalFact } from '../contracts/memory.ts';
import { migrate } from './migrations.ts';
import { sha256 } from '../workspace/project-identity.ts';

export type LexicalHit = Readonly<{ chunkId: string; documentKey: string; score: number }>;
export type VectorHit = Readonly<{ chunkId: string; documentKey: string; distance: number }>;
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
  + ' version, content_hash, observed_at, valid_from, valid_to, trust, metadata';

type Row = Record<string, SQLInputValue>;
const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const millis = (value?: string): number | null => value ? Date.parse(value) : null;
const iso = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
const vectorBlob = (vector: readonly number[]): Uint8Array => new Uint8Array(Float32Array.from(vector).buffer);
const tableNameFor = (model: string, dims: number): string => `vec_${sha256(`${model}\u0000${dims}`).slice(0, 16)}`;

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
  trust: String(row.trust) as SourceDocument['trust'], metadata: parse<Record<string, string>>(row.metadata, {}),
});

export class Projection {
  readonly path: string;
  readonly db: DatabaseSync;
  private depth = 0;
  private readonly statements = new Map<string, StatementSync>();
  private readonly termFrequency = new Map<string, number>();
  private chunks_: number | undefined;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { allowExtension: true });
    try {
      sqliteVec.load(this.db);
      migrate(this.db);
    } catch (error) {
      // Opening leaves an fd and a file lock held; migrate() rejects a schema
      // from a newer build, and that rejection must not leak the handle.
      this.db.close();
      throw error;
    }
  }

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

  close(): void {
    this.statements.clear();
    this.termFrequency.clear();
    this.chunks_ = undefined;
    this.db.close();
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
      if (payload.type === 'fact.recorded') this.insertFact(payload.fact);
      if (payload.type === 'fact.resolved') this.resolveFact(payload.factId, payload.standing, payload.replacementId, event.recordedAt);
      if (payload.type === 'retrieval.feedback') this.feedback(payload.factId, payload.signal, event.recordedAt);
      if (payload.type === 'gc.compacted') {
        for (const key of payload.removed) this.deleteDocumentKey(key, event.recordedAt);
      }
      this.stmt('INSERT INTO applied_events(id, event_hash, recorded_at) VALUES (?, ?, ?)')
        .run(event.id, event.eventHash, Date.parse(event.recordedAt));
      return true;
    });
  }

  upsertDocument(document: SourceDocument): void {
    const key = documentKey(document);
    this.stmt(`INSERT INTO documents(
      document_key, namespace, external_id, scope_id, scope_kind, source, kind, title, text, uri,
      version, content_hash, observed_at, valid_from, valid_to, trust, metadata, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(document_key) DO UPDATE SET
      scope_id=excluded.scope_id, scope_kind=excluded.scope_kind, source=excluded.source,
      kind=excluded.kind, title=excluded.title, text=excluded.text, uri=excluded.uri,
      version=excluded.version, content_hash=excluded.content_hash, observed_at=excluded.observed_at,
      valid_from=excluded.valid_from, valid_to=excluded.valid_to, trust=excluded.trust,
      metadata=excluded.metadata, deleted_at=NULL`)
      .run(key, document.namespace, document.externalId, document.scopeId, document.scopeKind,
        document.source, document.kind, document.title ?? null, document.text, document.uri ?? null,
        document.version, document.contentHash, Date.parse(document.observedAt), millis(document.validFrom),
        millis(document.validTo), document.trust, json(document.metadata));
  }

  deleteDocument(namespace: string, externalId: string, at: string): void {
    this.deleteDocumentKey(documentKey({ namespace, externalId }), at);
  }

  private deleteDocumentKey(key: string, at: string): void {
    this.deleteChunksForDocument(key);
    this.stmt('UPDATE documents SET deleted_at = ? WHERE document_key = ?').run(Date.parse(at), key);
  }

  replaceChunks(key: string, chunks: readonly DocumentChunk[], title?: string): void {
    this.replaceChunksBatch(chunks, title ? new Map([[key, title]]) : undefined);
  }

  replaceChunksBatch(chunks: readonly DocumentChunk[], titles?: ReadonlyMap<string, string>): void {
    this.chunks_ = undefined;
    this.transaction(() => {
      const keys = [...new Set(chunks.map(chunk => chunk.documentKey))];
      for (const key of keys) this.deleteChunksForDocument(key);
      const insert = this.stmt('INSERT INTO chunks(id, document_key, namespace, ordinal, title, text, content_hash, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const insertFts = this.stmt('INSERT INTO chunks_fts(chunk_id, title, text, metadata) VALUES (?, ?, ?, ?)');
      for (const chunk of chunks) {
        const title = titles?.get(chunk.documentKey);
        insert.run(chunk.id, chunk.documentKey, chunk.namespace, chunk.ordinal, title ?? null, chunk.text, chunk.contentHash, json(chunk.metadata));
        insertFts.run(chunk.id, title ?? '', chunk.text, Object.values(chunk.metadata).join(' '));
      }
    });
  }

  private deleteChunksForDocument(key: string): void {
    this.chunks_ = undefined;
    const ids = this.stmt('SELECT id FROM chunks WHERE document_key = ? LIMIT ?').all(key, MAX_PAGE_SIZE).map(row => String((row as Row).id));
    for (const id of ids) this.deleteVectorForChunk(id);
    const removeFts = this.stmt('DELETE FROM chunks_fts WHERE chunk_id = ?');
    for (const id of ids) removeFts.run(id);
    this.stmt('DELETE FROM chunks WHERE document_key = ?').run(key);
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

  private insertFact(fact: TemporalFact): void {
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
      this.resolveFact(replaced, 'superseded', fact.id, fact.recordedAt);
    }
  }

  private resolveFact(id: string, standing: MemoryStanding, replacementId: string | undefined, at: string): void {
    const terminal = ['superseded', 'contradicted'].includes(standing);
    this.stmt(`UPDATE facts SET standing = ?, replacement_id = ?, expired_at = ?,
      invalid_at = CASE WHEN ?=1 AND (invalid_at IS NULL OR invalid_at > ?) THEN ? ELSE invalid_at END WHERE id = ?`)
      .run(standing, replacementId ?? null, terminal ? Date.parse(at) : null,
        terminal ? 1 : 0, Date.parse(at), Date.parse(at), id);
    if (replacementId) this.stmt("INSERT OR IGNORE INTO fact_links(from_fact_id, to_fact_id, relation) VALUES (?, ?, 'resolves')").run(replacementId, id);
  }

  private feedback(id: string, signal: 'used' | 'helpful' | 'wrong' | 'stale', at: string): void {
    const column = signal;
    this.stmt(`INSERT INTO usefulness(fact_id, ${column}, last_signal_at) VALUES (?, 1, ?)
      ON CONFLICT(fact_id) DO UPDATE SET ${column}=${column}+1, last_signal_at=excluded.last_signal_at`)
      .run(id, Date.parse(at));
  }

  ensureVectorCollection(model: string, dims: number): { key: string; table: string } {
    if (!Number.isSafeInteger(dims) || dims < 8 || dims > 8192) throw new Error('Invalid embedding dimensions.');
    const key = sha256(`${model}\u0000${dims}`);
    const table = tableNameFor(model, dims);
    // Unit-normalized provider vectors are scalar-quantized by sqlite-vec to
    // int8: four times less disk and memory than float32 with the same shape.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding int8[${dims}])`);
    this.stmt(`INSERT INTO vector_collections(model_key, model, dims, table_name, created_at, active)
      VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(model_key) DO UPDATE SET active=1`)
      .run(key, model, dims, table, Date.now());
    return { key, table };
  }

  storeVector(chunkId: string, model: string, vector: readonly number[]): void {
    this.storeVectors([{ chunkId, vector }], model);
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
    for (const row of rows) this.stmt(`DELETE FROM ${String(row.table_name)} WHERE rowid = ?`).run(row.rowid!);
    this.stmt('DELETE FROM vector_map WHERE chunk_id = ?').run(chunkId);
  }

  // None of the three search legs joins `documents` any more. Soft-deleting a
  // document runs deleteChunksForDocument, which physically removes its chunks,
  // its FTS rows and its vectors — so a `d.deleted_at IS NULL` filter could
  // never exclude anything, and the join was pure cost: four tables deep on the
  // dense leg, three on the lexical one.
  vectorSearch(model: string, dims: number, vector: readonly number[], limit: number): VectorHit[] {
    if (vector.some(value => !Number.isFinite(value))) throw new Error('Embedding query must be finite.');
    const collection = this.ensureVectorCollection(model, dims);
    const rows = this.stmt(`SELECT v.distance, vm.chunk_id, c.document_key
      FROM ${collection.table} v
      JOIN vector_map vm ON vm.rowid=v.rowid AND vm.model_key=?
      JOIN chunks c ON c.id=vm.chunk_id
      WHERE v.embedding MATCH vec_quantize_int8(?, 'unit') AND k=?
      ORDER BY v.distance`).all(collection.key, vectorBlob(vector), Math.max(1, Math.min(1000, limit))) as Row[];
    return rows.map(row => ({ chunkId: String(row.chunk_id), documentKey: String(row.document_key), distance: Number(row.distance) }));
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
    const rows = this.stmt(`SELECT m.chunk_id, m.rank, c.document_key FROM (
        SELECT f.chunk_id AS chunk_id, bm25(chunks_fts, 8.0, 2.0, 1.0) AS rank
        FROM chunks_fts f WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?
      ) m JOIN chunks c ON c.id=m.chunk_id ORDER BY m.rank LIMIT ?`).all(expression, capped, capped) as Row[];
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

  chunkCount(document: Pick<SourceDocument, 'namespace' | 'externalId'>): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM chunks WHERE document_key=?').get(documentKey(document)) as Row;
    return Number(row.n);
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

  chunks(ids: readonly string[]): Array<DocumentChunk & { document: SourceDocument }> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.stmt(`SELECT c.id AS chunk_id, c.document_key AS chunk_document_key, c.namespace AS chunk_namespace,
      c.ordinal AS chunk_ordinal, c.text AS chunk_text, c.content_hash AS chunk_hash, c.metadata AS chunk_metadata,
      d.namespace, d.external_id, d.scope_id, d.scope_kind, d.source, d.kind, d.title, d.text AS document_text,
      d.uri, d.version, d.content_hash, d.observed_at, d.valid_from, d.valid_to, d.trust, d.metadata
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

  getFact(id: string): StoredFact | undefined {
    const row = this.stmt(`SELECT f.scope_id, f.kind, f.statement, f.subject, f.predicate, f.object, f.standing,
      f.confidence, f.valid_at, f.invalid_at, f.recorded_at, f.expired_at, f.tags, f.replacement_id,
      COALESCE(u.used + 2*u.helpful - 3*u.wrong - 2*u.stale, 0) AS utility
      FROM facts f LEFT JOIN usefulness u ON u.fact_id=f.id WHERE f.id=? LIMIT 1`).get(id) as Row | undefined;
    if (!row) return undefined;
    const evidenceRows = this.stmt(`SELECT e.id, e.origin, e.provenance, e.uri, e.content_hash, e.excerpt,
      e.observed_at, e.actor_id, e.session_id, e.tool_call_id
      FROM evidence e JOIN fact_evidence fe ON fe.evidence_id=e.id WHERE fe.fact_id=? LIMIT ?`).all(id, RELATION_LIMIT) as Row[];
    const entityRows = this.stmt(`SELECT e.id, e.scope_id, e.name, e.type, e.aliases, e.summary
      FROM entities e JOIN fact_entities fe ON fe.entity_id=e.id WHERE fe.fact_id=? LIMIT ?`).all(id, RELATION_LIMIT) as Row[];
    const episodeRows = this.stmt('SELECT episode_id FROM fact_episodes WHERE fact_id=? LIMIT ?').all(id, RELATION_LIMIT) as Row[];
    return {
      id, scopeId: String(row.scope_id), kind: String(row.kind) as StoredFact['kind'], statement: String(row.statement),
      ...(row.subject ? { subject: String(row.subject) } : {}), ...(row.predicate ? { predicate: String(row.predicate) } : {}),
      ...(row.object ? { object: String(row.object) } : {}), standing: String(row.standing) as StoredFact['standing'],
      confidence: Number(row.confidence), ...(iso(row.valid_at) ? { validAt: iso(row.valid_at)! } : {}),
      ...(iso(row.invalid_at) ? { invalidAt: iso(row.invalid_at)! } : {}), recordedAt: new Date(Number(row.recorded_at)).toISOString(),
      ...(iso(row.expired_at) ? { expiredAt: iso(row.expired_at)! } : {}), tags: parse<Record<string, string>>(row.tags, {}),
      entities: entityRows.map(entity => ({ id: String(entity.id), scopeId: String(entity.scope_id), name: String(entity.name),
        type: String(entity.type), aliases: parse<string[]>(entity.aliases, []), ...(entity.summary ? { summary: String(entity.summary) } : {}) })),
      evidence: evidenceRows.map(evidence => ({ id: String(evidence.id), origin: String(evidence.origin) as EvidenceRef['origin'],
        provenance: String(evidence.provenance) as EvidenceRef['provenance'], ...(evidence.uri ? { uri: String(evidence.uri) } : {}),
        contentHash: String(evidence.content_hash), excerpt: String(evidence.excerpt), observedAt: new Date(Number(evidence.observed_at)).toISOString(),
        ...(evidence.actor_id ? { actorId: String(evidence.actor_id) } : {}), ...(evidence.session_id ? { sessionId: String(evidence.session_id) } : {}),
        ...(evidence.tool_call_id ? { toolCallId: String(evidence.tool_call_id) } : {}) })),
      episodeIds: episodeRows.map(episode => String(episode.episode_id)),
      ...(row.replacement_id ? { supersedes: [String(row.replacement_id)] } : {}), usefulness: Number(row.utility),
    };
  }

  graphNeighbors(factIds: readonly string[], limit: number): StoredFact[] {
    if (!factIds.length) return [];
    const placeholders = factIds.map(() => '?').join(',');
    const rows = this.stmt(`SELECT DISTINCT f2.id FROM fact_entities a
      JOIN fact_entities b ON b.entity_id=a.entity_id AND b.fact_id<>a.fact_id
      JOIN facts f2 ON f2.id=b.fact_id
      WHERE a.fact_id IN (${placeholders})
      ORDER BY f2.recorded_at DESC LIMIT ?`).all(...factIds, limit) as Row[];
    return rows.flatMap(row => this.getFact(String(row.id)) ?? []);
  }

  activeFacts(scopeId: string, limit = PAGE_SIZE): StoredFact[] {
    const rows = this.stmt(`SELECT id FROM facts WHERE scope_id=? AND standing IN ('supported','needs_review','candidate')
      ORDER BY recorded_at DESC LIMIT ?`).all(scopeId, Math.max(1, Math.min(MAX_PAGE_SIZE, limit))) as Row[];
    return rows.flatMap(row => this.getFact(String(row.id)) ?? []);
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

  // Two columns instead of the whole row: a source sync only needs to know
  // which keys changed, not to load the corpus it is about to compare against.
  *eachDocumentHash(batch = PAGE_SIZE): Generator<{ documentKey: string; contentHash: string }> {
    const cursor: { after?: string } = {};
    for (;;) {
      const rows = (cursor.after === undefined
        ? this.stmt('SELECT document_key, content_hash FROM documents WHERE deleted_at IS NULL ORDER BY document_key LIMIT ?').all(batch)
        : this.stmt(`SELECT document_key, content_hash FROM documents WHERE deleted_at IS NULL AND document_key > ?
            ORDER BY document_key LIMIT ?`).all(cursor.after, batch)) as Row[];
      for (const row of rows) yield { documentKey: String(row.document_key), contentHash: String(row.content_hash) };
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
         OR (d.namespace='memory' AND f.standing IN ('superseded','contradicted') AND f.recorded_at < ?)
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
          this.db.exec(`DROP TABLE IF EXISTS ${String(collection.table_name)}`);
          this.stmt('DELETE FROM vector_map WHERE model_key=?').run(collection.model_key!);
          this.stmt('DELETE FROM vector_collections WHERE model_key=?').run(collection.model_key!);
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
    Projection.discardStaleRebuilds(path);
    const temporary = `${path}.rebuild-${process.pid}`;
    const scrub = (target: string): void => {
      rmSync(target, { force: true });
      rmSync(`${target}-wal`, { force: true });
      rmSync(`${target}-shm`, { force: true });
    };
    scrub(temporary);
    const projection = new Projection(temporary);
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
    return new Projection(path);
  }
}
