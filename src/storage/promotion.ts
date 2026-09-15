import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MemoryEvent } from '../contracts/events.ts';
import { validateEvent } from './journal.ts';
import { Projection } from './projection.ts';
import { CompactStore, type CompactDomainState } from './compact-store.ts';

const materializeJournal = (root: string, events: readonly MemoryEvent[], projectId: string): void => {
  const streams = events.reduce((writers, event) => {
    writers.set(event.writerId, [...writers.get(event.writerId) ?? [], event]);
    return writers;
  }, new Map<string, MemoryEvent[]>());
  for (const items of streams.values()) {
    const chain: { previous?: MemoryEvent } = {};
    for (const event of items.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.sequence - b.sequence)) {
      chain.previous = validateEvent(event, chain.previous, projectId);
    }
  }
  const grouped = new Map<string, MemoryEvent[]>();
  for (const event of events) {
    const day = event.recordedAt.slice(0, 10).replaceAll('-', '');
    const path = join(root, 'events', day, `${event.writerId}.jsonl`);
    grouped.set(path, [...grouped.get(path) ?? [], event]);
  }
  for (const [path, items] of grouped) {
    const content = items.sort((a, b) => a.sequence - b.sequence).map(event => `${JSON.stringify(event)}\n`).join('');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (existing !== undefined && !content.startsWith(existing)) throw new Error('Promotion journal conflicts with existing history.');
    if (existing === content) continue;
    const fd = openSync(path, existing === undefined ? 'wx' : 'a', 0o600);
    try { writeFileSync(fd, content.slice(existing?.length ?? 0)); fsyncSync(fd); } finally { closeSync(fd); }
    if (existing === undefined) {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
};

const importState = (projection: Projection, state: CompactDomainState, projectId: string): void => {
  const db = projection.db;
  for (const event of state.history) projection.apply(event);
  for (const entry of Object.values(state.documents)) {
    projection.upsertDocument(entry.document);
    if (entry.deletedAt !== null) projection.deleteDocument(entry.document.namespace, entry.document.externalId, new Date(entry.deletedAt).toISOString());
  }
  const vectorRows = Object.entries(state.vectors).flatMap(([chunkId, vector]) => state.chunks[chunkId]
    ? [{ chunkId, vector: vector.values }] : []);
  const vectorsByModel = vectorRows.reduce((groups, row) => {
    const model = state.vectors[row.chunkId]!.model;
    groups.set(model, [...groups.get(model) ?? [], row]);
    return groups;
  }, new Map<string, typeof vectorRows>());
  for (const [model, rows] of vectorsByModel) projection.storeVectors(rows, model);
  db.prepare('UPDATE sync_activity SET turns=?,tokens=?,inserts=?,updated_at=? WHERE id=1')
    .run(state.activity.turns, state.activity.tokens, state.activity.inserts, state.activity.updatedAt);
  const sync = db.prepare(`INSERT OR REPLACE INTO sync_state(adapter,last_at,at_turns,at_tokens,at_inserts,discovered,indexed,ok,detail)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const run of Object.values(state.sync)) sync.run(run.adapter, Date.parse(run.lastAt), run.at.turns, run.at.tokens, run.at.inserts,
    run.discovered, run.indexed, run.ok ? 1 : 0, run.detail ?? null);
  const checkpoint = db.prepare('INSERT OR REPLACE INTO operational_checkpoints(project_id,session_id,body,updated_at) VALUES (?,?,?,?)');
  for (const [key, value] of Object.entries(state.checkpoints)) {
    const split = key.indexOf('\u0000');
    checkpoint.run(key.slice(0, split), key.slice(split + 1), value.body, value.updatedAt);
  }

  const fingerprint = db.prepare(`INSERT OR REPLACE INTO fingerprints(document_key,adapter,namespace,external_id,revision,content_hash,kind,title,uri,
    observed_at,valid_from,valid_to,trust,metadata,withdrawn_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [key, item] of Object.entries(state.curation.fingerprints)) fingerprint.run(key, item.adapter, item.namespace, item.externalId,
    item.revision, item.contentHash, item.kind, item.title ?? null, item.uri ?? null, Date.parse(item.observedAt),
    item.validFrom ? Date.parse(item.validFrom) : null, item.validTo ? Date.parse(item.validTo) : null, item.trust,
    JSON.stringify(item.metadata), item.withdrawnAt ?? null, item.updatedAt);
  const job = db.prepare(`INSERT OR REPLACE INTO jobs(id,scope_id,adapter,document_key,action,status,input_revision,content_hash,topic_revision,attempts,
    lease_owner,lease_until,next_attempt_at,error_code,error_detail,created_at,updated_at,published_at,output_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of Object.values(state.curation.jobs)) job.run(item.id, item.scopeId, item.adapter, item.documentKey, item.action, item.status,
    item.inputRevision, item.contentHash, item.topicRevision ?? null, item.attempts, item.leaseOwner ?? null, item.leaseUntil ?? null,
    item.nextAttemptAt, item.errorCode ?? null, item.errorDetail ?? null, item.createdAt, item.updatedAt, item.publishedAt ?? null, item.outputRevision ?? null);
  const watermark = db.prepare('INSERT OR REPLACE INTO watermarks(adapter,document_key,revision,outcome,at) VALUES (?,?,?,?,?)');
  for (const [key, item] of Object.entries(state.curation.watermarks)) {
    const split = key.indexOf('\u0000');
    watermark.run(key.slice(0, split), key.slice(split + 1), item.revision, item.outcome, item.at);
  }
  const topic = db.prepare('INSERT OR REPLACE INTO topics(id,scope_id,title,summary,revision,summary_hash,fact_ids,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const item of Object.values(state.curation.topics)) topic.run(item.id, item.scopeId, item.title, item.summary, item.revision,
    item.summaryHash, JSON.stringify(item.factIds), item.updatedAt);
  const batch = db.prepare(`INSERT OR REPLACE INTO batches(id,job_id,document_key,source_revision,content_hash,topic_expected,payloads,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const item of Object.values(state.curation.batches)) batch.run(item.id, item.jobId, item.documentKey, item.sourceRevision,
    item.contentHash, item.topicExpected, JSON.stringify(item.payloads), item.state, item.createdAt);
  const coverage = db.prepare('INSERT OR REPLACE INTO coverage(document_key,offset,total,updated_at) VALUES (?,?,?,?)');
  for (const [key, item] of Object.entries(state.curation.coverage)) coverage.run(key, item.offset, item.total, item.updatedAt);
  const draft = db.prepare('INSERT OR REPLACE INTO window_drafts(document_key,revision,window_offset,fact_ids,qualifications,summary) VALUES (?,?,?,?,?,?)');
  for (const [key, item] of Object.entries(state.curation.drafts)) {
    const offsetAt = key.lastIndexOf('\u0000');
    const revisionAt = key.lastIndexOf('\u0000', offsetAt - 1);
    draft.run(key.slice(0, revisionAt), key.slice(revisionAt + 1, offsetAt), item.offset,
      JSON.stringify(item.factIds), JSON.stringify(item.qualifications), item.summary);
  }
  const dependency = db.prepare('INSERT OR REPLACE INTO dependencies(fact_id,document_key,adapter,revision) VALUES (?,?,?,?)');
  for (const item of Object.values(state.curation.dependencies)) dependency.run(item.factId, item.documentKey, item.adapter, item.revision);
  const spend = db.prepare('INSERT OR REPLACE INTO spend(day,calls,input_tokens,output_tokens,embedding_calls) VALUES (?,?,?,?,?)');
  for (const item of Object.values(state.curation.spend)) spend.run(item.day, item.calls, item.inputTokens, item.outputTokens, item.embeddingCalls);

  const counts = projection.stats();
  const expectedTables: Readonly<Record<string, number>> = {
    documents: Object.keys(state.documents).length,
    chunks: Object.keys(state.chunks).length,
    applied_events: Object.keys(state.applied).length,
    facts: Object.keys(state.facts).length,
    evidence: Object.keys(state.evidence).length,
    entities: Object.keys(state.entities).length,
    episodes: Object.keys(state.episodes).length,
    fingerprints: Object.keys(state.curation.fingerprints).length,
    jobs: Object.keys(state.curation.jobs).length,
    watermarks: Object.keys(state.curation.watermarks).length,
    topics: Object.keys(state.curation.topics).length,
    batches: Object.keys(state.curation.batches).length,
    coverage: Object.keys(state.curation.coverage).length,
    window_drafts: Object.keys(state.curation.drafts).length,
    dependencies: Object.keys(state.curation.dependencies).length,
    spend: Object.keys(state.curation.spend).length,
    sync_state: Object.keys(state.sync).length,
    operational_checkpoints: Object.keys(state.checkpoints).length,
  };
  const mismatched = Object.entries(expectedTables).filter(([table, expected]) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
    return Number(row?.n) !== expected;
  });
  const owner = db.prepare('SELECT project_id FROM memory_owner LIMIT 1').get() as { project_id?: string } | undefined;
  const hashesMatch = state.history.every(event => {
    const row = db.prepare('SELECT event_hash FROM applied_events WHERE id=?').get(event.id) as { event_hash?: string } | undefined;
    return row?.event_hash === event.eventHash;
  });
  if (owner?.project_id !== projectId || !hashesMatch || mismatched.length
    || counts.documents !== expectedTables.documents || counts.chunks !== expectedTables.chunks
    || counts.facts !== expectedTables.facts || counts.vectors !== vectorRows.length) {
    throw new Error(`Indexed promotion verification failed before authority switch${mismatched.length ? `: ${mismatched.map(([table]) => table).join(',')}` : ''}.`);
  }
  db.prepare('UPDATE compact_authority SET mode=1 WHERE id=1 AND mode=0').run();
  const mode = db.prepare('SELECT mode FROM compact_authority WHERE id=1').get() as { mode?: number } | undefined;
  if (mode?.mode !== 1) throw new Error('Indexed promotion lost its authority fence.');
};

/**
 * The schema may be staged while compact mode 0 remains authoritative. Logical
 * state and the mode marker are then published in one outer SQLite transaction;
 * mode is the final write. The returned Projection owns the promoted connection.
 */
export const promoteCompactAuthority = (root: string, path: string, projectId: string, compact: CompactStore): Projection => {
  // Additive schema staging is harmless while mode 0 remains the sole authority.
  const staged = new Projection(path, undefined, { allowCompactPromotion: true });
  const stagedCuration = staged.attachCuration(path);
  try { staged.claimOwner(projectId); } finally { stagedCuration.close(); staged.close(); }

  // Re-read under the compact write lock. No client can commit between this
  // snapshot and the final mode marker, so promotion cannot lose a late event.
  compact.withPromotionLock((state, db) => {
    materializeJournal(root, state.history, projectId);
    const projection = new Projection(db, path, { allowCompactPromotion: true, transactionActive: true });
    const curation = projection.attachCuration(path);
    try { importState(projection, state, projectId); }
    finally { curation.close(); projection.close(); }
  });
  return new Projection(path);
};
