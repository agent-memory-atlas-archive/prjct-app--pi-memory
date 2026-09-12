import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
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

type Row = Record<string, SQLInputValue>;
const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const millis = (value?: string): number | null => value ? Date.parse(value) : null;
const iso = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
const vectorBlob = (vector: readonly number[]): Uint8Array => new Uint8Array(Float32Array.from(vector).buffer);
const tableNameFor = (model: string, dims: number): string => `vec_${sha256(`${model}\u0000${dims}`).slice(0, 16)}`;

export class Projection {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { allowExtension: true });
    sqliteVec.load(this.db);
    migrate(this.db);
  }

  close(): void { this.db.close(); }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  hasEvent(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM applied_events WHERE id = ?').get(id));
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
      this.db.prepare('INSERT INTO applied_events(id, event_hash, recorded_at) VALUES (?, ?, ?)')
        .run(event.id, event.eventHash, Date.parse(event.recordedAt));
      return true;
    });
  }

  upsertDocuments(documents: readonly SourceDocument[]): void {
    this.transaction(() => {
      for (const document of documents) this.upsertDocument(document);
    });
  }

  upsertDocument(document: SourceDocument): void {
    const key = documentKey(document);
    this.db.prepare(`INSERT INTO documents(
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
    this.db.prepare('UPDATE documents SET deleted_at = ? WHERE document_key = ?').run(Date.parse(at), key);
  }

  replaceChunks(key: string, chunks: readonly DocumentChunk[], title?: string): void {
    this.replaceChunksBatch(chunks, title ? new Map([[key, title]]) : undefined);
  }

  replaceChunksBatch(chunks: readonly DocumentChunk[], titles?: ReadonlyMap<string, string>): void {
    this.transaction(() => {
      const keys = [...new Set(chunks.map(chunk => chunk.documentKey))];
      for (const key of keys) this.deleteChunksForDocument(key);
      const insert = this.db.prepare('INSERT INTO chunks(id, document_key, namespace, ordinal, title, text, content_hash, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const insertFts = this.db.prepare('INSERT INTO chunks_fts(chunk_id, title, text, metadata) VALUES (?, ?, ?, ?)');
      for (const chunk of chunks) {
        const title = titles?.get(chunk.documentKey);
        insert.run(chunk.id, chunk.documentKey, chunk.namespace, chunk.ordinal, title ?? null, chunk.text, chunk.contentHash, json(chunk.metadata));
        insertFts.run(chunk.id, title ?? '', chunk.text, Object.values(chunk.metadata).join(' '));
      }
    });
  }

  private deleteChunksForDocument(key: string): void {
    const ids = this.db.prepare('SELECT id FROM chunks WHERE document_key = ?').all(key).map(row => String((row as Row).id));
    for (const id of ids) this.deleteVectorForChunk(id);
    const removeFts = this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
    for (const id of ids) removeFts.run(id);
    this.db.prepare('DELETE FROM chunks WHERE document_key = ?').run(key);
  }

  private insertEvidence(evidence: EvidenceRef): void {
    this.db.prepare(`INSERT INTO evidence(id, origin, provenance, uri, content_hash, excerpt, observed_at, actor_id, session_id, tool_call_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(evidence.id, evidence.origin, evidence.provenance, evidence.uri ?? null,
      evidence.contentHash, evidence.excerpt, Date.parse(evidence.observedAt), evidence.actorId ?? null,
      evidence.sessionId ?? null, evidence.toolCallId ?? null);
  }

  private insertEpisode(episode: Episode): void {
    this.db.prepare(`INSERT INTO episodes(id, scope_id, kind, summary, observed_at, actor_id, session_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(episode.id, episode.scopeId, episode.kind, episode.summary, Date.parse(episode.observedAt),
        episode.actorId ?? null, episode.sessionId ?? null, episode.source);
    for (const evidence of episode.evidence) {
      this.insertEvidence(evidence);
      this.db.prepare('INSERT OR IGNORE INTO episode_evidence(episode_id, evidence_id) VALUES (?, ?)').run(episode.id, evidence.id);
    }
  }

  private insertEntity(entity: Entity): void {
    this.db.prepare(`INSERT INTO entities(id, scope_id, name, type, aliases, summary) VALUES (?, ?, ?, ?, ?, ?)
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
    this.db.prepare(`INSERT INTO facts(id, scope_id, kind, statement, subject, predicate, object, standing,
      confidence, valid_at, invalid_at, recorded_at, expired_at, tags, replacement_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO NOTHING`).run(fact.id, fact.scopeId, fact.kind, fact.statement,
      fact.subject ?? null, fact.predicate ?? null, fact.object ?? null, fact.standing, fact.confidence,
      millis(fact.validAt), millis(fact.invalidAt), Date.parse(fact.recordedAt), millis(fact.expiredAt), json(fact.tags));
    for (const evidence of fact.evidence) {
      this.insertEvidence(evidence);
      this.db.prepare('INSERT OR IGNORE INTO fact_evidence(fact_id, evidence_id) VALUES (?, ?)').run(fact.id, evidence.id);
    }
    for (const entity of fact.entities) {
      this.insertEntity(entity);
      this.db.prepare('INSERT OR IGNORE INTO fact_entities(fact_id, entity_id) VALUES (?, ?)').run(fact.id, entity.id);
    }
    for (const episodeId of fact.episodeIds) this.db.prepare('INSERT OR IGNORE INTO fact_episodes(fact_id, episode_id) VALUES (?, ?)').run(fact.id, episodeId);
    for (const replaced of fact.supersedes ?? []) {
      this.db.prepare("INSERT OR IGNORE INTO fact_links(from_fact_id, to_fact_id, relation) VALUES (?, ?, 'supersedes')").run(fact.id, replaced);
      this.resolveFact(replaced, 'superseded', fact.id, fact.recordedAt);
    }
  }

  private resolveFact(id: string, standing: MemoryStanding, replacementId: string | undefined, at: string): void {
    const terminal = ['superseded', 'contradicted'].includes(standing);
    this.db.prepare(`UPDATE facts SET standing = ?, replacement_id = ?, expired_at = ?,
      invalid_at = CASE WHEN ?=1 AND (invalid_at IS NULL OR invalid_at > ?) THEN ? ELSE invalid_at END WHERE id = ?`)
      .run(standing, replacementId ?? null, terminal ? Date.parse(at) : null,
        terminal ? 1 : 0, Date.parse(at), Date.parse(at), id);
    if (replacementId) this.db.prepare("INSERT OR IGNORE INTO fact_links(from_fact_id, to_fact_id, relation) VALUES (?, ?, 'resolves')").run(replacementId, id);
  }

  private feedback(id: string, signal: 'used' | 'helpful' | 'wrong' | 'stale', at: string): void {
    const column = signal;
    this.db.prepare(`INSERT INTO usefulness(fact_id, ${column}, last_signal_at) VALUES (?, 1, ?)
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
    this.db.prepare(`INSERT INTO vector_collections(model_key, model, dims, table_name, created_at, active)
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
      const find = this.db.prepare('SELECT rowid FROM vector_map WHERE chunk_id = ? AND model_key = ?');
      const addMap = this.db.prepare('INSERT INTO vector_map(chunk_id, model_key) VALUES (?, ?)');
      const addVector = this.db.prepare(`INSERT INTO ${collection.table}(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))`);
      const removeVector = this.db.prepare(`DELETE FROM ${collection.table} WHERE rowid = ?`);
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
    const rows = this.db.prepare(`SELECT vm.rowid, vc.table_name FROM vector_map vm
      JOIN vector_collections vc ON vc.model_key=vm.model_key WHERE vm.chunk_id=?`).all(chunkId) as Row[];
    for (const row of rows) this.db.prepare(`DELETE FROM ${String(row.table_name)} WHERE rowid = ?`).run(row.rowid!);
    this.db.prepare('DELETE FROM vector_map WHERE chunk_id = ?').run(chunkId);
  }

  vectorSearch(model: string, dims: number, vector: readonly number[], limit: number): VectorHit[] {
    if (vector.some(value => !Number.isFinite(value))) throw new Error('Embedding query must be finite.');
    const collection = this.ensureVectorCollection(model, dims);
    const rows = this.db.prepare(`SELECT v.rowid, v.distance, vm.chunk_id, c.document_key
      FROM ${collection.table} v
      JOIN vector_map vm ON vm.rowid=v.rowid AND vm.model_key=?
      JOIN chunks c ON c.id=vm.chunk_id
      JOIN documents d ON d.document_key=c.document_key
      WHERE v.embedding MATCH vec_quantize_int8(?, 'unit') AND k=? AND d.deleted_at IS NULL
      ORDER BY v.distance`).all(collection.key, vectorBlob(vector), Math.max(1, Math.min(1000, limit))) as Row[];
    return rows.map(row => ({ chunkId: String(row.chunk_id), documentKey: String(row.document_key), distance: Number(row.distance) }));
  }

  lexicalSearch(query: string, limit: number): LexicalHit[] {
    const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? [];
    if (!tokens.length) return [];
    const expression = [...new Set(tokens.slice(0, 24))].map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT f.chunk_id, c.document_key, bm25(chunks_fts, 8.0, 2.0, 1.0) AS rank
      FROM chunks_fts f JOIN chunks c ON c.id=f.chunk_id JOIN documents d ON d.document_key=c.document_key
      WHERE chunks_fts MATCH ? AND d.deleted_at IS NULL ORDER BY rank LIMIT ?`).all(expression, limit) as Row[];
    return rows.map(row => ({ chunkId: String(row.chunk_id), documentKey: String(row.document_key), score: 1 / (1 + Math.abs(Number(row.rank))) }));
  }

  exactSearch(query: string, limit: number): LexicalHit[] {
    const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    const rows = this.db.prepare(`SELECT c.id AS chunk_id, c.document_key FROM chunks c
      JOIN documents d ON d.document_key=c.document_key
      WHERE d.deleted_at IS NULL AND (c.text LIKE ? ESCAPE '\\' OR c.id=? OR d.external_id=? OR d.uri LIKE ? ESCAPE '\\')
      LIMIT ?`).all(`%${escaped}%`, query, query, `%${escaped}%`, limit) as Row[];
    return rows.map(row => ({ chunkId: String(row.chunk_id), documentKey: String(row.document_key), score: 1 }));
  }

  chunkCount(document: Pick<SourceDocument, 'namespace' | 'externalId'>): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_key=?').get(documentKey(document)) as Row;
    return Number(row.n);
  }

  unembeddedChunks(model: string): Array<DocumentChunk & { document: SourceDocument }> {
    const rows = this.db.prepare(`SELECT c.id FROM chunks c
      JOIN documents d ON d.document_key=c.document_key
      WHERE d.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM vector_map vm JOIN vector_collections vc ON vc.model_key=vm.model_key
        WHERE vm.chunk_id=c.id AND vc.model=?
      ) ORDER BY c.id`).all(model) as Row[];
    return this.chunks(rows.map(row => String(row.id)));
  }

  chunks(ids: readonly string[]): Array<DocumentChunk & { document: SourceDocument }> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT c.id AS chunk_id, c.document_key AS chunk_document_key, c.namespace AS chunk_namespace,
      c.ordinal AS chunk_ordinal, c.text AS chunk_text, c.content_hash AS chunk_hash, c.metadata AS chunk_metadata,
      d.namespace, d.external_id, d.scope_id, d.scope_kind, d.source, d.kind, d.title, d.text AS document_text,
      d.uri, d.version, d.content_hash, d.observed_at, d.valid_from, d.valid_to, d.trust, d.metadata
      FROM chunks c JOIN documents d ON d.document_key=c.document_key WHERE c.id IN (${placeholders})`).all(...ids) as Row[];
    const byId = new Map(rows.map(row => [String(row.chunk_id), row]));
    return ids.flatMap(id => {
      const row = byId.get(id);
      if (!row) return [];
      const document: SourceDocument = {
        namespace: String(row.namespace), externalId: String(row.external_id), scopeId: String(row.scope_id),
        scopeKind: String(row.scope_kind) as SourceDocument['scopeKind'], source: String(row.source), kind: String(row.kind),
        ...(row.title ? { title: String(row.title) } : {}), text: String(row.document_text), ...(row.uri ? { uri: String(row.uri) } : {}),
        version: String(row.version), contentHash: String(row.content_hash), observedAt: new Date(Number(row.observed_at)).toISOString(),
        ...(iso(row.valid_from) ? { validFrom: iso(row.valid_from)! } : {}), ...(iso(row.valid_to) ? { validTo: iso(row.valid_to)! } : {}),
        trust: String(row.trust) as SourceDocument['trust'], metadata: parse<Record<string, string>>(row.metadata, {}),
      };
      return [{ id, documentKey: String(row.chunk_document_key), namespace: String(row.chunk_namespace), ordinal: Number(row.chunk_ordinal),
        text: String(row.chunk_text), contentHash: String(row.chunk_hash), metadata: parse<Record<string, string>>(row.chunk_metadata, {}), document }];
    });
  }

  getFact(id: string): StoredFact | undefined {
    const row = this.db.prepare(`SELECT f.*, COALESCE(u.used + 2*u.helpful - 3*u.wrong - 2*u.stale, 0) AS utility
      FROM facts f LEFT JOIN usefulness u ON u.fact_id=f.id WHERE f.id=?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const evidenceRows = this.db.prepare(`SELECT e.* FROM evidence e JOIN fact_evidence fe ON fe.evidence_id=e.id WHERE fe.fact_id=?`).all(id) as Row[];
    const entityRows = this.db.prepare(`SELECT e.* FROM entities e JOIN fact_entities fe ON fe.entity_id=e.id WHERE fe.fact_id=?`).all(id) as Row[];
    const episodeRows = this.db.prepare('SELECT episode_id FROM fact_episodes WHERE fact_id=?').all(id) as Row[];
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
    const rows = this.db.prepare(`SELECT DISTINCT f2.id FROM fact_entities a
      JOIN fact_entities b ON b.entity_id=a.entity_id AND b.fact_id<>a.fact_id
      JOIN facts f2 ON f2.id=b.fact_id
      WHERE a.fact_id IN (${placeholders})
      ORDER BY f2.recorded_at DESC LIMIT ?`).all(...factIds, limit) as Row[];
    return rows.flatMap(row => this.getFact(String(row.id)) ?? []);
  }

  activeFacts(scopeId: string): StoredFact[] {
    const rows = this.db.prepare("SELECT id FROM facts WHERE scope_id=? AND standing IN ('supported','needs_review','candidate') ORDER BY recorded_at DESC").all(scopeId) as Row[];
    return rows.flatMap(row => this.getFact(String(row.id)) ?? []);
  }

  activeDocuments(): SourceDocument[] {
    const rows = this.db.prepare('SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY document_key').all() as Row[];
    return rows.map(row => ({ namespace: String(row.namespace), externalId: String(row.external_id), scopeId: String(row.scope_id),
      scopeKind: String(row.scope_kind) as SourceDocument['scopeKind'], source: String(row.source), kind: String(row.kind),
      ...(row.title ? { title: String(row.title) } : {}), text: String(row.text), ...(row.uri ? { uri: String(row.uri) } : {}),
      version: String(row.version), contentHash: String(row.content_hash), observedAt: new Date(Number(row.observed_at)).toISOString(),
      ...(iso(row.valid_from) ? { validFrom: iso(row.valid_from)! } : {}), ...(iso(row.valid_to) ? { validTo: iso(row.valid_to)! } : {}),
      trust: String(row.trust) as SourceDocument['trust'], metadata: parse<Record<string, string>>(row.metadata, {}) }));
  }

  stats(): { documents: number; chunks: number; vectors: number; facts: number; events: number; bytes: number } {
    const count = (table: string): number => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
    const pageCount = Number((this.db.prepare('PRAGMA page_count').get() as Row).page_count);
    const pageSize = Number((this.db.prepare('PRAGMA page_size').get() as Row).page_size);
    return { documents: count('documents'), chunks: count('chunks'), vectors: count('vector_map'), facts: count('facts'), events: count('applied_events'), bytes: pageCount * pageSize };
  }

  gcCandidates(now = Date.now()): string[] {
    const rows = this.db.prepare(`SELECT d.document_key, d.namespace, f.standing, f.recorded_at,
      COALESCE(u.used + u.helpful, 0) AS positive
      FROM documents d LEFT JOIN facts f ON d.namespace='memory' AND f.id=d.external_id
      LEFT JOIN usefulness u ON u.fact_id=f.id
      WHERE d.deleted_at IS NOT NULL
         OR (d.namespace='memory' AND f.standing IN ('superseded','contradicted') AND f.recorded_at < ?)
         OR (d.namespace='memory' AND f.standing IN ('candidate','needs_review') AND COALESCE(u.used + u.helpful, 0)=0 AND f.recorded_at < ?)`)
      .all(now - 7 * 86_400_000, now - 30 * 86_400_000) as Row[];
    return rows.map(row => String(row.document_key));
  }

  gcProjection(reachableDocumentKeys: ReadonlySet<string>, activeModel?: string): string[] {
    const rows = this.db.prepare('SELECT document_key FROM documents WHERE deleted_at IS NOT NULL').all() as Row[];
    const removable = rows.map(row => String(row.document_key)).filter(key => !reachableDocumentKeys.has(key));
    this.transaction(() => {
      for (const key of removable) {
        this.deleteChunksForDocument(key);
        this.db.prepare('DELETE FROM documents WHERE document_key=?').run(key);
      }
      if (activeModel) {
        const stale = this.db.prepare('SELECT model_key, table_name FROM vector_collections WHERE model<>?').all(activeModel) as Row[];
        for (const collection of stale) {
          this.db.exec(`DROP TABLE IF EXISTS ${String(collection.table_name)}`);
          this.db.prepare('DELETE FROM vector_map WHERE model_key=?').run(collection.model_key!);
          this.db.prepare('DELETE FROM vector_collections WHERE model_key=?').run(collection.model_key!);
        }
      }
      this.db.exec('PRAGMA incremental_vacuum(200)');
    });
    return removable;
  }

  static rebuild(path: string, events: readonly MemoryEvent[]): Projection {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const projection = new Projection(path);
    for (const event of events) projection.apply(event);
    return projection;
  }
}
