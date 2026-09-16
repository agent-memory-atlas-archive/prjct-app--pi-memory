import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { documentKey } from '../contracts/documents.ts';
import { redactSecrets } from '../security/redact.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { privateDatabaseFiles, privateDirectorySync } from '../storage/private-files.ts';
import { CurationBlockError, type CurationJob, type CurationStats, type JobAction, type JobStatus, type SourceIdentity, type Spend } from './types.ts';

type Row = Record<string, SQLInputValue>;
const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const iso = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

const jobFromRow = (row: Row): CurationJob => ({
  id: String(row.id), scopeId: String(row.scope_id), adapter: String(row.adapter),
  documentKey: String(row.document_key), action: String(row.action) as JobAction,
  status: String(row.status) as JobStatus, inputRevision: String(row.input_revision),
  contentHash: String(row.content_hash),
  ...(row.topic_revision ? { topicRevision: String(row.topic_revision) } : {}),
  attempts: Number(row.attempts),
  ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
  ...(row.lease_until != null ? { leaseUntil: Number(row.lease_until) } : {}),
  nextAttemptAt: Number(row.next_attempt_at),
  ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
  ...(row.error_detail ? { errorDetail: String(row.error_detail) } : {}),
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  ...(row.published_at != null ? { publishedAt: Number(row.published_at) } : {}),
  ...(row.output_revision ? { outputRevision: String(row.output_revision) } : {}),
});

const identityFromRow = (row: Row): SourceIdentity => ({
  adapter: String(row.adapter), documentKey: String(row.document_key), namespace: String(row.namespace),
  externalId: String(row.external_id), revision: String(row.revision), contentHash: String(row.content_hash),
  kind: String(row.kind), ...(row.title ? { title: String(row.title) } : {}),
  ...(row.uri ? { uri: String(row.uri) } : {}), observedAt: new Date(Number(row.observed_at)).toISOString(),
  ...(iso(row.valid_from) ? { validFrom: iso(row.valid_from)! } : {}),
  ...(iso(row.valid_to) ? { validTo: iso(row.valid_to)! } : {}),
  trust: String(row.trust) as SourceIdentity['trust'], metadata: parse(row.metadata, {}),
});

export const jobIdFor = (scopeId: string, action: JobAction, documentKeyValue: string, revision: string, generation = ''): string =>
  `job_${sha256(`${scopeId}\u0000${action}\u0000${documentKeyValue}\u0000${revision}\u0000${generation}`).slice(0, 24)}`;

const TERMINAL: readonly JobStatus[] = ['published', 'no_change', 'discarded'];

export const sanitizeDetail = (detail: string): string => redactSecrets(detail).replaceAll(/\s+/g, ' ').trim().slice(0, 180);

export const stillHeld = (job: CurationJob | undefined, owner: string, now: number): boolean =>
  Boolean(job && job.status === 'claimed' && job.leaseOwner === owner && (job.leaseUntil ?? 0) > now);

export type PublicationHold = Readonly<{
  store: Pick<CurationStore, 'getJob'>; jobId: string; owner: string; mode: 'publish' | 'retract';
}>;

export const publicationHold = new AsyncLocalStorage<PublicationHold>();

export const assertPublicationHold = (): void => {
  const ctx = publicationHold.getStore();
  if (!ctx || ctx.mode === 'retract') return;
  if (!stillHeld(ctx.store.getJob(ctx.jobId), ctx.owner, Date.now())) {
    throw new CurationBlockError('stale', 'Publication lease lost before a standing change.');
  }
};

export class CurationStore {
  readonly path: string;
  readonly db: DatabaseSync;
  private depth = 0;
  private readonly ownsConnection: boolean;
  private readonly statements = new Map<string, StatementSync>();

  constructor(pathOrDb: string | DatabaseSync, attachedPath?: string) {
    if (typeof pathOrDb === 'string') {
      this.path = pathOrDb;
      this.ownsConnection = true;
      privateDirectorySync(dirname(pathOrDb));
      this.db = new DatabaseSync(pathOrDb);
    } else {
      this.path = attachedPath ?? '';
      this.ownsConnection = false;
      this.db = pathOrDb;
    }
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec('PRAGMA foreign_keys=ON');
      const migrated = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get());
      if (migrated) {
        if (this.ownsConnection) privateDatabaseFiles(this.path);
        return;
      }
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS fingerprints (
          document_key TEXT PRIMARY KEY,
          adapter TEXT NOT NULL,
          namespace TEXT NOT NULL,
          external_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT,
          uri TEXT,
          observed_at INTEGER NOT NULL,
          valid_from INTEGER,
          valid_to INTEGER,
          trust TEXT NOT NULL,
          metadata TEXT NOT NULL,
          withdrawn_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_fingerprints_adapter ON fingerprints(adapter);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          adapter TEXT NOT NULL,
          document_key TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          input_revision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          topic_revision TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_until INTEGER,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_detail TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          published_at INTEGER,
          output_revision TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_jobs_claim ON jobs(status, next_attempt_at, lease_until);
        CREATE INDEX IF NOT EXISTS ix_jobs_key ON jobs(document_key, input_revision);
        CREATE TABLE IF NOT EXISTS spend (
          day TEXT PRIMARY KEY,
          calls INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          embedding_calls INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS topics (
          id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          revision INTEGER NOT NULL,
          summary_hash TEXT NOT NULL,
          fact_ids TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dependencies (
          fact_id TEXT NOT NULL,
          document_key TEXT NOT NULL,
          adapter TEXT NOT NULL,
          revision TEXT NOT NULL,
          PRIMARY KEY(fact_id, document_key)
        );
        CREATE INDEX IF NOT EXISTS ix_dep_source ON dependencies(document_key);
        CREATE TABLE IF NOT EXISTS watermarks (
          adapter TEXT NOT NULL,
          document_key TEXT NOT NULL,
          revision TEXT NOT NULL,
          outcome TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY(adapter, document_key)
        );
        CREATE TABLE IF NOT EXISTS batches (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          document_key TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          topic_expected INTEGER NOT NULL,
          payloads TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_batches_job ON batches(job_id, state);
        CREATE TABLE IF NOT EXISTS coverage (
          document_key TEXT PRIMARY KEY,
          offset INTEGER NOT NULL,
          total INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS window_drafts (
          document_key TEXT NOT NULL,
          revision TEXT NOT NULL,
          window_offset INTEGER NOT NULL,
          fact_ids TEXT NOT NULL,
          qualifications TEXT NOT NULL,
          summary TEXT NOT NULL,
          PRIMARY KEY(document_key, revision, window_offset)
        );
      `);
      if (this.ownsConnection) privateDatabaseFiles(this.path);
    } catch (error) {
      if (this.ownsConnection) this.db.close();
      throw error;
    }
  }

  adoptOuter(): void { this.depth += 1; }
  releaseOuter(): void { this.depth = Math.max(0, this.depth - 1); }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  close(): void {
    this.statements.clear();
    if (this.ownsConnection) this.db.close();
  }

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

  fingerprint(documentKeyValue: string): SourceIdentity | undefined {
    const row = this.stmt('SELECT * FROM fingerprints WHERE document_key=? LIMIT 1').get(documentKeyValue) as Row | undefined;
    return row && row.withdrawn_at == null ? identityFromRow(row) : undefined;
  }

  fingerprintOwner(documentKeyValue: string): string | undefined {
    const row = this.stmt('SELECT adapter FROM fingerprints WHERE document_key=? LIMIT 1').get(documentKeyValue) as Row | undefined;
    return row ? String(row.adapter) : undefined;
  }

  adapterFingerprints(adapter: string): SourceIdentity[] {
    const rows = this.stmt('SELECT * FROM fingerprints WHERE adapter=? AND withdrawn_at IS NULL').all(adapter) as Row[];
    return rows.map(identityFromRow);
  }

  upsertFingerprint(identity: SourceIdentity, at = Date.now()): void {
    const prior = this.fingerprint(identity.documentKey);
    if (prior && (prior.revision !== identity.revision || prior.contentHash !== identity.contentHash)) {
      this.stmt('DELETE FROM coverage WHERE document_key=?').run(identity.documentKey);
    }
    this.stmt(`INSERT INTO fingerprints(document_key, adapter, namespace, external_id, revision, content_hash, kind, title, uri,
      observed_at, valid_from, valid_to, trust, metadata, withdrawn_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(document_key) DO UPDATE SET adapter=excluded.adapter, namespace=excluded.namespace,
      external_id=excluded.external_id, revision=excluded.revision, content_hash=excluded.content_hash, kind=excluded.kind,
      title=excluded.title, uri=excluded.uri, observed_at=excluded.observed_at, valid_from=excluded.valid_from,
      valid_to=excluded.valid_to, trust=excluded.trust, metadata=excluded.metadata, withdrawn_at=NULL, updated_at=excluded.updated_at`)
      .run(identity.documentKey, identity.adapter, identity.namespace, identity.externalId, identity.revision,
        identity.contentHash, identity.kind, identity.title ?? null, identity.uri ?? null, Date.parse(identity.observedAt),
        identity.validFrom ? Date.parse(identity.validFrom) : null, identity.validTo ? Date.parse(identity.validTo) : null,
        identity.trust, json(identity.metadata), at);
  }

  markWithdrawn(documentKeyValue: string, at = Date.now()): void {
    this.stmt('UPDATE fingerprints SET withdrawn_at=?, updated_at=? WHERE document_key=?')
      .run(at, at, documentKeyValue);
  }

  enqueue(job: Omit<CurationJob, 'attempts' | 'createdAt' | 'updatedAt' | 'nextAttemptAt' | 'status'> & Readonly<{
    status?: JobStatus; attempts?: number; nextAttemptAt?: number;
  }>, at = Date.now()): CurationJob {
    return this.transaction(() => {
      const insert = (generation: number): CurationJob => {
        const id = generation === 0 ? job.id : jobIdFor(job.scopeId, job.action, job.documentKey, job.inputRevision, String(generation));
        const existing = this.stmt('SELECT * FROM jobs WHERE id=? LIMIT 1').get(id) as Row | undefined;
        if (existing && !TERMINAL.includes(String(existing.status) as JobStatus)) return jobFromRow(existing);
        if (existing && TERMINAL.includes(String(existing.status) as JobStatus)) {
          if (generation > 512) throw new Error('Curation job generation exhausted.');
          return insert(generation + 1);
        }
        this.stmt(`INSERT INTO jobs(id, scope_id, adapter, document_key, action, status, input_revision, content_hash,
          topic_revision, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, job.scopeId, job.adapter, job.documentKey, job.action, job.status ?? 'pending',
            job.inputRevision, job.contentHash, job.topicRevision ?? null, job.attempts ?? 0,
            job.nextAttemptAt ?? 0, at, at);
        return this.getJob(id)!;
      };
      return insert(0);
    });
  }

  discardOpenJobs(documentKeyValue: string, exceptRevision: string, at = Date.now()): number {
    const result = this.stmt(`UPDATE jobs SET status='discarded', updated_at=?, lease_owner=NULL, lease_until=NULL
      WHERE document_key=? AND input_revision<>? AND status IN ('pending','failed','blocked','claimed')`)
      .run(at, documentKeyValue, exceptRevision);
    return Number(result.changes);
  }

  getJob(id: string): CurationJob | undefined {
    const row = this.stmt('SELECT * FROM jobs WHERE id=? LIMIT 1').get(id) as Row | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  openJobs(limit = 1000): CurationJob[] {
    const rows = this.stmt(`SELECT * FROM jobs WHERE status IN ('pending','claimed','failed','blocked')
      ORDER BY created_at LIMIT ?`).all(limit) as Row[];
    return rows.map(jobFromRow);
  }

  /**
   * Transactional scoped lease. A competing or expired claim cannot take a job
   * another living worker still holds.
   */
  claim(owner: string, leaseMs: number, now = Date.now()): CurationJob | undefined {
    return this.transaction(() => {
      const row = this.stmt(`SELECT * FROM jobs WHERE next_attempt_at <= ? AND (
          status IN ('pending','failed') AND (lease_until IS NULL OR lease_until < ?)
          OR status='claimed' AND lease_until < ?)
        ORDER BY created_at LIMIT 1`).get(now, now, now) as Row | undefined;
      if (!row) return undefined;
      const until = now + Math.max(1, leaseMs);
      this.stmt(`UPDATE jobs SET status='claimed', lease_owner=?, lease_until=?, attempts=attempts+1, updated_at=?
        WHERE id=? AND (status IN ('pending','failed') AND (lease_until IS NULL OR lease_until < ?)
          OR status='claimed' AND lease_until < ?)`)
        .run(owner, until, now, row.id, now, now);
      const held = this.stmt('SELECT * FROM jobs WHERE id=? AND lease_owner=? AND status=? LIMIT 1')
        .get(row.id, owner, 'claimed') as Row | undefined;
      return held ? jobFromRow(held) : undefined;
    });
  }

  release(id: string, owner: string, at = Date.now()): void {
    this.stmt(`UPDATE jobs SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND lease_owner=? AND status='claimed'`).run(at, id, owner);
  }

  finish(id: string, owner: string, outcome: Extract<JobStatus, 'published' | 'no_change' | 'discarded'>,
    outputRevision: string | undefined, at = Date.now(), watermark = true): boolean {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job || !stillHeld(job, owner, at)) return false;
      this.stmt(`UPDATE jobs SET status=?, output_revision=?, published_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?,
        error_code=NULL, error_detail=NULL WHERE id=? AND lease_owner=? AND status='claimed'`)
        .run(outcome, outputRevision ?? null, at, at, id, owner);
      if (watermark) {
        this.stmt(`INSERT INTO watermarks(adapter, document_key, revision, outcome, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(adapter, document_key) DO UPDATE SET revision=excluded.revision, outcome=excluded.outcome, at=excluded.at`)
          .run(job.adapter, job.documentKey, job.inputRevision, outcome, at);
      }
      return true;
    });
  }

  fail(id: string, owner: string, code: string, detail: string, retryAt: number, blocked = false, at = Date.now()): void {
    this.stmt(`UPDATE jobs SET status=?, error_code=?, error_detail=?, next_attempt_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND lease_owner=? AND status='claimed'`)
      .run(blocked ? 'blocked' : 'failed', code, sanitizeDetail(detail), retryAt, at, id, owner);
  }

  renew(id: string, owner: string, leaseMs: number, now = Date.now()): boolean {
    const until = now + Math.max(1, leaseMs);
    const result = this.stmt(`UPDATE jobs SET lease_until=?, updated_at=? WHERE id=? AND lease_owner=? AND status='claimed' AND lease_until > ?`)
      .run(until, now, id, owner, now);
    return Number(result.changes) === 1;
  }

  blockOpen(code: string, detail: string, at = Date.now()): number {
    const result = this.stmt(`UPDATE jobs SET status='blocked', error_code=?, error_detail=?, updated_at=?
      WHERE status IN ('pending','failed')`).run(code, sanitizeDetail(detail), at);
    return Number(result.changes);
  }

  unblock(code: string, at = Date.now()): number {
    const result = this.stmt(`UPDATE jobs SET status='pending', error_code=NULL, error_detail=NULL, next_attempt_at=0, updated_at=?
      WHERE status='blocked' AND error_code=?`).run(at, code);
    return Number(result.changes);
  }

  watermark(adapter: string, documentKeyValue: string): { revision: string; outcome: string } | undefined {
    const row = this.stmt('SELECT revision, outcome FROM watermarks WHERE adapter=? AND document_key=? LIMIT 1')
      .get(adapter, documentKeyValue) as Row | undefined;
    return row ? { revision: String(row.revision), outcome: String(row.outcome) } : undefined;
  }

  topic(id: string): { id: string; scopeId: string; title: string; summary: string; revision: number; factIds: string[] } | undefined {
    const row = this.stmt('SELECT * FROM topics WHERE id=? LIMIT 1').get(id) as Row | undefined;
    if (!row) return undefined;
    return { id: String(row.id), scopeId: String(row.scope_id), title: String(row.title), summary: String(row.summary),
      revision: Number(row.revision), factIds: parse<string[]>(row.fact_ids, []) };
  }

  topicRevision(id: string): number {
    return this.topic(id)?.revision ?? 0;
  }

  writeTopic(topic: { id: string; scopeId: string; title: string; summary: string; factIds: readonly string[] }, expectedRevision: number, at = Date.now()): number | undefined {
    return this.transaction(() => {
      const current = this.topicRevision(topic.id);
      if (current !== expectedRevision) return undefined;
      const next = current + 1;
      this.stmt(`INSERT INTO topics(id, scope_id, title, summary, revision, summary_hash, fact_ids, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, revision=excluded.revision,
        summary_hash=excluded.summary_hash, fact_ids=excluded.fact_ids, updated_at=excluded.updated_at
        WHERE topics.revision=?`)
        .run(topic.id, topic.scopeId, topic.title, topic.summary, next, sha256(topic.summary), json(topic.factIds), at, expectedRevision);
      return this.topicRevision(topic.id) === next ? next : undefined;
    });
  }

  linkFact(factId: string, identity: Pick<SourceIdentity, 'documentKey' | 'adapter' | 'revision'>): void {
    this.stmt(`INSERT INTO dependencies(fact_id, document_key, adapter, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(fact_id, document_key) DO UPDATE SET adapter=excluded.adapter, revision=excluded.revision`)
      .run(factId, identity.documentKey, identity.adapter, identity.revision);
  }

  dependents(documentKeyValue: string, revision?: string): string[] {
    const rows = (revision === undefined
      ? this.stmt('SELECT fact_id FROM dependencies WHERE document_key=?').all(documentKeyValue)
      : this.stmt('SELECT fact_id FROM dependencies WHERE document_key=? AND revision=?').all(documentKeyValue, revision)) as Row[];
    return rows.map(row => String(row.fact_id));
  }

  reserveCall(budget: { maxCallsPerDay: number; maxTokensPerDay: number }, at = Date.now(), tokens = 0): boolean {
    return this.transaction(() => {
      const current = this.spend(at);
      if (current.calls >= budget.maxCallsPerDay || (current.inputTokens + current.outputTokens + tokens) > budget.maxTokensPerDay) return false;
      this.recordSpend({ calls: 1, inputTokens: Math.max(0, tokens) }, at);
      return true;
    });
  }

  touchFingerprint(documentKeyValue: string, at = Date.now()): void {
    this.stmt('UPDATE fingerprints SET updated_at=? WHERE document_key=? AND withdrawn_at IS NULL').run(at, documentKeyValue);
  }

  coverage(documentKeyValue: string): { offset: number; total: number } | undefined {
    const row = this.stmt('SELECT offset, total FROM coverage WHERE document_key=? LIMIT 1').get(documentKeyValue) as Row | undefined;
    return row ? { offset: Number(row.offset), total: Number(row.total) } : undefined;
  }

  private ensureDrafts(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS window_drafts (
      document_key TEXT NOT NULL, revision TEXT NOT NULL, window_offset INTEGER NOT NULL,
      fact_ids TEXT NOT NULL, qualifications TEXT NOT NULL, summary TEXT NOT NULL,
      PRIMARY KEY(document_key, revision, window_offset))`);
  }

  windowDrafts(documentKeyValue: string, revision: string): readonly { offset: number; factIds: readonly string[]; qualifications: readonly string[]; summary: string }[] {
    try {
      const rows = this.stmt('SELECT window_offset, fact_ids, qualifications, summary FROM window_drafts WHERE document_key=? AND revision=? ORDER BY window_offset')
        .all(documentKeyValue, revision) as Row[];
      return rows.map(row => ({
        offset: Number(row.window_offset),
        factIds: parse<string[]>(row.fact_ids, []),
        qualifications: parse<string[]>(row.qualifications, []),
        summary: String(row.summary),
      }));
    } catch {
      return [];
    }
  }

  saveWindowDraft(documentKeyValue: string, revision: string, offset: number, factIds: readonly string[], qualifications: readonly string[], summary: string): void {
    this.ensureDrafts();
    this.stmt(`INSERT INTO window_drafts(document_key, revision, window_offset, fact_ids, qualifications, summary)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(document_key, revision, window_offset)
      DO UPDATE SET fact_ids=excluded.fact_ids, qualifications=excluded.qualifications, summary=excluded.summary`)
      .run(documentKeyValue, revision, offset, json(factIds), json(qualifications), summary.slice(0, 1500));
  }

  clearWindowDrafts(documentKeyValue: string, revision: string): void {
    try { this.stmt('DELETE FROM window_drafts WHERE document_key=? AND revision=?').run(documentKeyValue, revision); } catch { /* table may not exist yet */ }
  }

  setCoverage(documentKeyValue: string, offset: number, total: number, at = Date.now()): void {
    if (offset >= total) {
      this.stmt('DELETE FROM coverage WHERE document_key=?').run(documentKeyValue);
      return;
    }
    this.stmt(`INSERT INTO coverage(document_key, offset, total, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(document_key) DO UPDATE SET offset=excluded.offset, total=excluded.total, updated_at=excluded.updated_at`)
      .run(documentKeyValue, offset, total, at);
  }

  fingerprintAgeMs(documentKeyValue: string, now = Date.now()): number | undefined {
    const row = this.stmt('SELECT updated_at FROM fingerprints WHERE document_key=? AND withdrawn_at IS NULL LIMIT 1')
      .get(documentKeyValue) as Row | undefined;
    return row ? now - Number(row.updated_at) : undefined;
  }

  spend(at = Date.now()): Spend {
    const day = utcDay(at);
    const row = this.stmt('SELECT * FROM spend WHERE day=? LIMIT 1').get(day) as Row | undefined;
    return { day, calls: Number(row?.calls ?? 0), inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0), embeddingCalls: Number(row?.embedding_calls ?? 0) };
  }

  recordSpend(delta: Readonly<{ calls?: number; inputTokens?: number; outputTokens?: number; embeddingCalls?: number }>, at = Date.now()): Spend {
    const day = utcDay(at);
    this.stmt(`INSERT INTO spend(day, calls, input_tokens, output_tokens, embedding_calls) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET calls=calls+excluded.calls, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, embedding_calls=embedding_calls+excluded.embedding_calls`)
      .run(day, Math.max(0, Math.trunc(delta.calls ?? 0)), Math.max(0, Math.trunc(delta.inputTokens ?? 0)),
        Math.max(0, Math.trunc(delta.outputTokens ?? 0)), Math.max(0, Math.trunc(delta.embeddingCalls ?? 0)));
    return this.spend(at);
  }

  stats(at = Date.now()): CurationStats {
    const count = (status: string): number =>
      Number((this.stmt('SELECT COUNT(*) AS n FROM jobs WHERE status=?').get(status) as Row).n);
    return {
      fingerprints: Number((this.stmt('SELECT COUNT(*) AS n FROM fingerprints WHERE withdrawn_at IS NULL').get() as Row).n),
      pending: count('pending'), claimed: count('claimed'), failed: count('failed'), blocked: count('blocked'),
      published: count('published'), spend: this.spend(at),
    };
  }

  acceptBatch(job: CurationJob, identity: SourceIdentity, topicId: string, expectedTopic: number, payloads: unknown, owner: string, at = Date.now()): string | undefined {
    return this.transaction(() => {
      if (!stillHeld(this.getJob(job.id), owner, Date.now())) return undefined;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return undefined;
      if (this.topicRevision(topicId) !== expectedTopic) return undefined;
      const id = `batch_${sha256(`${job.id}\u0000${job.inputRevision}\u0000${at}`).slice(0, 24)}`;
      this.stmt(`INSERT INTO batches(id, job_id, document_key, source_revision, content_hash, topic_expected, payloads, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`)
        .run(id, job.id, identity.documentKey, job.inputRevision, job.contentHash, expectedTopic, json(payloads), at);
      return id;
    });
  }

  abortBatch(id: string): void {
    this.stmt("UPDATE batches SET state='aborted' WHERE id=? AND state IN ('accepted','committed','sealed','materializing')").run(id);
  }

  pendingBatches(): readonly { id: string; payloads: unknown; sourceRevision: string; documentKey: string; jobId: string; state: string }[] {
    const rows = this.stmt("SELECT id, payloads, source_revision, document_key, job_id, state FROM batches WHERE state IN ('committed','sealed','materializing')").all() as Row[];
    return rows.map(row => ({ id: String(row.id), payloads: parse(row.payloads, {}), sourceRevision: String(row.source_revision),
      documentKey: String(row.document_key), jobId: String(row.job_id), state: String(row.state) }));
  }

  claimMaterialize(batchId: string): boolean {
    const result = this.stmt("UPDATE batches SET state='materializing' WHERE id=? AND state IN ('committed','sealed')").run(batchId);
    return Number(result.changes) === 1;
  }

  batchRecord(id: string): { documentKey: string; sourceRevision: string; state: string } | undefined {
    const row = this.stmt('SELECT document_key, source_revision, state FROM batches WHERE id=?').get(id) as Row | undefined;
    return row ? { documentKey: String(row.document_key), sourceRevision: String(row.source_revision), state: String(row.state) } : undefined;
  }

  acceptedBatch(jobId: string): { id: string; payloads: unknown; topicExpected: number; sourceRevision: string; state: string } | undefined {
    const row = this.stmt("SELECT * FROM batches WHERE job_id=? AND state IN ('accepted','committed','sealed','materializing') ORDER BY created_at DESC LIMIT 1").get(jobId) as Row | undefined;
    if (!row) return undefined;
    return { id: String(row.id), payloads: parse(row.payloads, {}), topicExpected: Number(row.topic_expected),
      sourceRevision: String(row.source_revision), state: String(row.state) };
  }

  commitBatch(batchId: string, job: CurationJob, identity: SourceIdentity, topicId: string, owner: string): boolean {
    return this.transaction(() => {
      if (!stillHeld(this.getJob(job.id), owner, Date.now())) return false;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return false;
      const batch = this.stmt('SELECT payloads, topic_expected FROM batches WHERE id=?').get(batchId) as Row | undefined;
      if (!batch) return false;
      if (this.topicRevision(topicId) !== Number(batch.topic_expected ?? -1)) return false;
      const payloads = parse<{ factIds?: unknown }>(batch.payloads, {});
      const factIds = Array.isArray(payloads.factIds) ? payloads.factIds.filter((id): id is string => typeof id === 'string') : [];
      for (const id of factIds) this.linkFact(id, identity);
      const result = this.stmt("UPDATE batches SET state='committed' WHERE id=? AND state='accepted'").run(batchId);
      return Number(result.changes) === 1;
    });
  }

  finishWindow(jobId: string, owner: string, documentKeyValue: string, adapter: string, inputRevision: string, contentHash: string,
    scopeId: string, consumed: number, total: number, truncated: boolean, topicRevision: string | undefined, at = Date.now()): boolean {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || !stillHeld(job, owner, Date.now())) return false;
      if (truncated) {
        if (consumed >= total) this.stmt('DELETE FROM coverage WHERE document_key=?').run(documentKeyValue);
        else {
          this.stmt(`INSERT INTO coverage(document_key, offset, total, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(document_key) DO UPDATE SET offset=excluded.offset, total=excluded.total, updated_at=excluded.updated_at`)
            .run(documentKeyValue, consumed, total, at);
        }
        const open = this.stmt("SELECT 1 FROM jobs WHERE document_key=? AND action='analyze' AND status IN ('pending','claimed','failed','blocked') AND id<>? LIMIT 1")
          .get(documentKeyValue, jobId);
        if (!open) {
          const contId = jobIdFor(scopeId, 'analyze', documentKeyValue, `${inputRevision}:cover:${consumed}`);
          const existing = this.getJob(contId);
          if (!existing || TERMINAL.includes(existing.status)) {
            this.enqueue({
              id: contId, scopeId, adapter, documentKey: documentKeyValue, action: 'analyze',
              inputRevision, contentHash, ...(topicRevision ? { topicRevision } : {}),
            }, at);
          }
        }
        this.stmt(`UPDATE jobs SET status='published', published_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?,
          error_code=NULL, error_detail=NULL WHERE id=? AND lease_owner=? AND status='claimed'`).run(at, at, jobId, owner);
        return true;
      }
      this.stmt('DELETE FROM coverage WHERE document_key=?').run(documentKeyValue);
      this.stmt('UPDATE fingerprints SET updated_at=? WHERE document_key=? AND withdrawn_at IS NULL').run(at, documentKeyValue);
      this.stmt(`UPDATE jobs SET status='published', published_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?,
        error_code=NULL, error_detail=NULL WHERE id=? AND lease_owner=? AND status='claimed'`).run(at, at, jobId, owner);
      this.stmt(`INSERT INTO watermarks(adapter, document_key, revision, outcome, at) VALUES (?, ?, ?, 'published', ?)
        ON CONFLICT(adapter, document_key) DO UPDATE SET revision=excluded.revision, outcome=excluded.outcome, at=excluded.at`)
        .run(adapter, documentKeyValue, inputRevision, at);
      return true;
    });
  }

  markApplied(id: string): void {
    this.stmt("UPDATE batches SET state='applied' WHERE id=? AND state='accepted'").run(id);
  }

  sealCommitted(batchId: string, job: CurationJob, identity: SourceIdentity, topicId: string, owner: string, at = Date.now()): boolean {
    return this.transaction(() => {
      const batch = this.stmt('SELECT * FROM batches WHERE id=?').get(batchId) as Row | undefined;
      if (!batch) return false;
      if (String(batch.state) === 'applied' || String(batch.state) === 'sealed' || String(batch.state) === 'materializing') return true;
      if (String(batch.state) !== 'committed') return false;
      if (!stillHeld(this.getJob(job.id), owner, Date.now())) return false;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return false;
      if (this.topicRevision(topicId) !== Number(batch.topic_expected ?? -1)) return false;
      const result = this.stmt("UPDATE batches SET state='sealed' WHERE id=? AND state='committed'").run(batchId);
      return Number(result.changes) === 1;
    });
  }

  finishPublish(batchId: string, job: CurationJob, identity: SourceIdentity, topicId: string, at = Date.now(), fullSource = true): boolean {
    return this.transaction(() => {
      const batch = this.stmt('SELECT * FROM batches WHERE id=?').get(batchId) as Row | undefined;
      if (!batch) return false;
      if (String(batch.state) === 'applied') return true;
      const live = this.fingerprint(identity.documentKey);
      if (!live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash) return false;
      const expected = Number(batch.topic_expected ?? -1);
      const payloads = parse<{ documents?: { text?: string; title?: string }[]; factIds?: unknown }>(batch.payloads, {});
      const factIds = Array.isArray(payloads.factIds) ? payloads.factIds.filter((id): id is string => typeof id === 'string') : [];
      const summary = payloads.documents?.[0]?.text ?? '';
      if (summary) {
        const current = this.topicRevision(topicId);
        if (current === expected) {
          const next = this.writeTopic({
            id: topicId, scopeId: job.scopeId, title: payloads.documents?.[0]?.title ?? identity.kind, summary, factIds,
          }, expected, at);
          if (next === undefined) return false;
        }
      }
      this.stmt("UPDATE batches SET state='applied' WHERE id=? AND state IN ('committed','sealed','materializing')").run(batchId);
      if (fullSource) {
        this.stmt(`UPDATE jobs SET status='published', published_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?,
          error_code=NULL, error_detail=NULL WHERE id=? AND status IN ('claimed','failed')`)
          .run(at, at, job.id);
        this.stmt(`INSERT INTO watermarks(adapter, document_key, revision, outcome, at) VALUES (?, ?, ?, 'published', ?)
          ON CONFLICT(adapter, document_key) DO UPDATE SET revision=excluded.revision, outcome=excluded.outcome, at=excluded.at`)
          .run(job.adapter, job.documentKey, job.inputRevision, at);
      }
      return String((this.stmt('SELECT state FROM batches WHERE id=?').get(batchId) as Row | undefined)?.state) === 'applied';
    });
  }

  sealPublication(jobId: string, owner: string, batchId: string, outcome: 'published' | 'no_change', outputRevision: string | undefined, watermark: boolean, at = Date.now()): boolean {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || job.leaseOwner !== owner) return false;
      if (job.status === 'published' || job.status === 'no_change') return true;
      const batch = this.stmt('SELECT state FROM batches WHERE id=?').get(batchId) as Row | undefined;
      if (String(batch?.state) !== 'committed' && String(batch?.state) !== 'applied') return false;
      this.stmt(`UPDATE jobs SET status=?, output_revision=?, published_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?,
        error_code=NULL, error_detail=NULL WHERE id=? AND lease_owner=? AND status='claimed'`)
        .run(outcome, outputRevision ?? null, at, at, jobId, owner);
      this.stmt("UPDATE batches SET state='applied' WHERE id=? AND state='committed'").run(batchId);
      if (watermark) {
        this.stmt(`INSERT INTO watermarks(adapter, document_key, revision, outcome, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(adapter, document_key) DO UPDATE SET revision=excluded.revision, outcome=excluded.outcome, at=excluded.at`)
          .run(job.adapter, job.documentKey, job.inputRevision, outcome, at);
      }
      return true;
    });
  }
}

const META_ALLOW = new Set(['adapter', 'revision', 'facts', 'semanticKey', 'sourceRevision', 'sourceAdapter', 'sourceDocumentKey', 'sources', 'parent']);

export const safeMetadata = (metadata: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(metadata).flatMap(([key, value]) => {
    if (!META_ALLOW.has(key)) return [];
    const redacted = redactSecrets(value).slice(0, 1024);
    return [[key, redacted]] as const;
  }));

export const identityFromDocument = (adapter: string, document: {
  namespace: string; externalId: string; kind: string; title?: string; uri?: string;
  contentHash: string; observedAt: string; validFrom?: string; validTo?: string;
  trust: SourceIdentity['trust']; metadata: Readonly<Record<string, string>>;
  sync?: { adapter: string; revision: string };
}): SourceIdentity => ({
  adapter, documentKey: documentKey(document), namespace: document.namespace, externalId: document.externalId,
  revision: document.sync?.revision ?? document.contentHash, contentHash: document.contentHash, kind: document.kind,
  ...(document.title ? { title: redactSecrets(document.title).slice(0, 256) } : {}),
  ...(document.uri ? { uri: redactSecrets(document.uri).slice(0, 1024) } : {}),
  observedAt: document.observedAt, ...(document.validFrom ? { validFrom: document.validFrom } : {}),
  ...(document.validTo ? { validTo: document.validTo } : {}), trust: document.trust, metadata: safeMetadata(document.metadata),
});
