import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const readVersion = (db: DatabaseSync): number => {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: unknown } | undefined;
  const version = Number(row?.value ?? 0);
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new Error(`Unsupported memory projection schema: ${row?.value}`);
  return version;
};

export const migrate = (db: DatabaseSync): void => {
  readVersion(db);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
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
  `);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
};
