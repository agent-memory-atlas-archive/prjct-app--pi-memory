import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 4;

export const prepareConnection = (db: DatabaseSync): void => {
  db.exec('PRAGMA busy_timeout=5000');
};

export const schemaIsCurrent = (db: DatabaseSync): boolean => {
  const row = (() => {
    try {
      return db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: unknown } | undefined;
    } catch {
      return undefined;
    }
  })();
  if (!row) return false;
  const version = Number(row.value ?? 0);
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new Error(`Unsupported memory projection schema: ${row.value}`);
  return version === SCHEMA_VERSION;
};

const readVersion = (db: DatabaseSync): number => {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: unknown } | undefined;
  const version = Number(row?.value ?? 0);
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new Error(`Unsupported memory projection schema: ${row?.value}`);
  return version;
};

export const claimMemoryOwner = (db: DatabaseSync, projectId: string): void => {
  if (!/^p_[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('Memory opens only a project-owned database.');
  const owner = (() => {
    try {
      return db.prepare('SELECT project_id FROM memory_owner LIMIT 1').get() as { project_id?: string } | undefined;
    } catch {
      return undefined;
    }
  })();
  if (owner?.project_id === projectId) return;
  if (owner?.project_id) throw new Error('Memory database is owned by another project.');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_owner (project_id TEXT NOT NULL UNIQUE, claimed_at INTEGER NOT NULL)`);
  const populated = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get()
    ? db.prepare('SELECT 1 FROM facts LIMIT 1').get()
    : undefined;
  if (!owner && populated) throw new Error('Legacy memory has no verifiable project ownership.');
  if (!owner) {
    db.prepare('INSERT INTO memory_owner(project_id, claimed_at) VALUES (?, ?)').run(projectId, Date.now());
    return;
  }
  if (owner.project_id !== projectId) throw new Error('Memory database is owned by another project.');
};

export const migrate = (db: DatabaseSync): void => {
  prepareConnection(db);
  if (schemaIsCurrent(db)) {
    db.exec('PRAGMA foreign_keys=ON');
    return;
  }
  readVersion(db);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS memory_owner (
      project_id TEXT NOT NULL UNIQUE,
      claimed_at INTEGER NOT NULL
    );
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA auto_vacuum=INCREMENTAL;

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applied_events (
      id TEXT PRIMARY KEY,
      event_hash TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      document_key TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      external_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      uri TEXT,
      version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      trust TEXT NOT NULL,
      metadata TEXT NOT NULL,
      deleted_at INTEGER,
      UNIQUE(namespace, external_id)
    );
    CREATE INDEX IF NOT EXISTS ix_documents_scope ON documents(scope_id, namespace, kind) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ix_documents_hash ON documents(content_hash) WHERE deleted_at IS NULL;
    -- UNIQUE(namespace, external_id) cannot serve a lookup on external_id alone,
    -- which left exactSearch scanning the whole table on every query.
    CREATE INDEX IF NOT EXISTS ix_documents_external ON documents(external_id) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_key TEXT NOT NULL REFERENCES documents(document_key) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata TEXT NOT NULL,
      UNIQUE(document_key, ordinal)
    );
    CREATE INDEX IF NOT EXISTS ix_chunks_document ON chunks(document_key, ordinal);
    CREATE INDEX IF NOT EXISTS ix_chunks_namespace ON chunks(namespace);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED, title, text, metadata,
      tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
    );
    -- Per-term document frequency, read straight off the existing FTS index.
    -- lexicalSearch uses it to keep the informative terms of a prose query and
    -- drop the near-ubiquitous ones instead of OR-ing all of them.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_vocab USING fts5vocab(chunks_fts, 'row');

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      actor_id TEXT,
      session_id TEXT,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      provenance TEXT NOT NULL,
      uri TEXT,
      content_hash TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      actor_id TEXT,
      session_id TEXT,
      tool_call_id TEXT
    );
    CREATE TABLE IF NOT EXISTS episode_evidence (
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      PRIMARY KEY(episode_id, evidence_id)
    );
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      aliases TEXT NOT NULL,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_entities_name ON entities(scope_id, name);
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      statement TEXT NOT NULL,
      subject TEXT,
      predicate TEXT,
      object TEXT,
      standing TEXT NOT NULL,
      confidence REAL NOT NULL,
      valid_at INTEGER,
      invalid_at INTEGER,
      recorded_at INTEGER NOT NULL,
      expired_at INTEGER,
      tags TEXT NOT NULL,
      replacement_id TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_facts_scope_standing ON facts(scope_id, standing, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS ix_facts_temporal ON facts(scope_id, valid_at, invalid_at);
    CREATE TABLE IF NOT EXISTS fact_entities (
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      PRIMARY KEY(fact_id, entity_id)
    );
    CREATE TABLE IF NOT EXISTS fact_evidence (
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      PRIMARY KEY(fact_id, evidence_id)
    );
    CREATE TABLE IF NOT EXISTS fact_episodes (
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES episodes(id),
      PRIMARY KEY(fact_id, episode_id)
    );
    CREATE TABLE IF NOT EXISTS fact_links (
      from_fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      to_fact_id TEXT NOT NULL REFERENCES facts(id),
      relation TEXT NOT NULL,
      PRIMARY KEY(from_fact_id, to_fact_id, relation)
    );
    CREATE TABLE IF NOT EXISTS usefulness (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      used REAL NOT NULL DEFAULT 0,
      helpful REAL NOT NULL DEFAULT 0,
      wrong REAL NOT NULL DEFAULT 0,
      stale REAL NOT NULL DEFAULT 0,
      last_signal_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vector_collections (
      model_key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      table_name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS vector_map (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL,
      model_key TEXT NOT NULL REFERENCES vector_collections(model_key) ON DELETE CASCADE,
      UNIQUE(chunk_id, model_key)
    );

    -- Operational handoff state is deliberately outside documents/chunks/FTS,
    -- the semantic journal, vector indexes, curation and ordinary memory stats.
    CREATE TABLE IF NOT EXISTS operational_checkpoints (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, session_id)
    );

    -- What this scope has done since it started, counted monotonically. Sync is
    -- driven by work performed, not by a clock: a session that sits idle has
    -- nothing new to pull, and one that has been busy for an hour does.
    CREATE TABLE IF NOT EXISTS sync_activity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      turns INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      inserts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO sync_activity(id) VALUES (1) ON CONFLICT(id) DO NOTHING;

    -- One row per source adapter: when it last ran, what it found, and the
    -- activity watermark at that moment. The deltas against sync_activity are
    -- what make an adapter due.
    CREATE TABLE IF NOT EXISTS sync_state (
      adapter TEXT PRIMARY KEY,
      last_at INTEGER NOT NULL,
      at_turns INTEGER NOT NULL,
      at_tokens INTEGER NOT NULL,
      at_inserts INTEGER NOT NULL,
      discovered INTEGER NOT NULL DEFAULT 0,
      indexed INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      detail TEXT
    );
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    const documentColumns = db.prepare('PRAGMA table_info(documents)').all();
    if (!documentColumns.some(column => column.name === 'source_adapter')) db.exec('ALTER TABLE documents ADD COLUMN source_adapter TEXT;');
    if (!documentColumns.some(column => column.name === 'source_revision')) db.exec('ALTER TABLE documents ADD COLUMN source_revision TEXT;');
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
