import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';
import { privateDatabaseFiles, privateDirectorySync } from './private-files.ts';
import { acquireMaintenanceLock } from './maintenance-lock.ts';

type Snapshot = Readonly<{ owner?: string; documents: string; chunks: string; facts: string; events: string }>;

const digest = (db: DatabaseSync, sql: string): string => {
  try {
    const hash = createHash('sha256');
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
    return `${rows.length}:${hash.digest('hex')}`;
  } catch { return 'missing'; }
};

const snapshot = (db: DatabaseSync): Snapshot => ({
  owner: (db.prepare("SELECT project_id FROM memory_owner LIMIT 1").get() as { project_id?: string } | undefined)?.project_id,
  documents: digest(db, 'SELECT document_key,content_hash,version,deleted_at FROM documents ORDER BY document_key'),
  chunks: digest(db, 'SELECT id,document_key,ordinal,content_hash FROM chunks ORDER BY id'),
  facts: digest(db, 'SELECT id,statement,standing,tags FROM facts ORDER BY id'),
  events: digest(db, 'SELECT id,event_hash,recorded_at FROM applied_events ORDER BY id'),
});

const integrity = (db: DatabaseSync): void => {
  const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
  if (String(Object.values(row ?? {})[0]) !== 'ok') throw new Error('Memory migration integrity check failed.');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Memory migration foreign-key verification failed.');
};

const fsyncPath = (path: string): void => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

const versionAt = (path: string): number | undefined => {
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='compact_authority'").get()) return undefined;
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: unknown } | undefined;
    return Number(row?.value ?? 0);
  } catch {
    return undefined;
  } finally { db.close(); }
};

export const migrateIndexedPath = (path: string, maintenanceHeld = false): string | undefined => {
  if (versionAt(path) !== 4) return undefined;
  const root = dirname(path);
  privateDirectorySync(root);
  const releaseMaintenance = maintenanceHeld ? undefined : acquireMaintenanceLock(root);
  const checkpoints = join(root, 'checkpoints');
  privateDirectorySync(checkpoints);
  const stamp = `${Date.now()}-${process.pid}`;
  const backupTemporary = join(checkpoints, `pre-v5-${stamp}.sqlite.tmp`);
  const backup = join(checkpoints, `pre-v5-${stamp}.sqlite`);
  const rewrite = join(root, `.${basename(path)}.v5-${stamp}.tmp`);
  const source = new DatabaseSync(path);
  try {
    const available = statfsSync(root).bavail * statfsSync(root).bsize;
    const liveBytes = statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0);
    if (available < liveBytes * 3 + 16 * 1024 * 1024) throw new Error('Insufficient free space for the verified v5 backup and atomic rewrite.');
    source.exec('PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    const before = snapshot(source);
    if (!before.owner) throw new Error('V4 memory database has no project owner; refusing migration.');
    source.exec(`VACUUM INTO '${backupTemporary.replaceAll("'", "''")}'`);
    privateDatabaseFiles(backupTemporary);
    const backupDb = new DatabaseSync(backupTemporary, { readOnly: true });
    try {
      integrity(backupDb);
      const version = Number((backupDb.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: unknown } | undefined)?.value ?? 0);
      if (version !== 4 || JSON.stringify(snapshot(backupDb)) !== JSON.stringify(before)) throw new Error('Pre-v5 backup verification failed.');
    } finally { backupDb.close(); }
    fsyncPath(backupTemporary);
    renameSync(backupTemporary, backup);
    fsyncPath(checkpoints);
    copyFileSync(backup, rewrite);
    privateDatabaseFiles(rewrite);
    const candidate = new DatabaseSync(rewrite);
    try {
      candidate.exec('PRAGMA journal_mode=DELETE; PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
      migrate(candidate);
      integrity(candidate);
      const after = snapshot(candidate);
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('V5 rewrite changed durable memory records.');
      const invalidVector = candidate.prepare("SELECT table_name FROM vector_collections WHERE table_name NOT GLOB 'vec_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'").get();
      if (invalidVector) throw new Error('V5 rewrite contains an invalid vector table name.');
      const fts = candidate.prepare('SELECT count(*) AS n FROM chunks_fts').get() as { n?: number } | undefined;
      const chunks = candidate.prepare('SELECT count(*) AS n FROM chunks').get() as { n?: number } | undefined;
      if (Number(fts?.n ?? -1) !== Number(chunks?.n ?? -2)) throw new Error('V5 FTS rebuild is incomplete.');
      if (Number(Object.values(candidate.prepare('PRAGMA page_size').get() ?? {})[0]) !== 4096
        || Number(Object.values(candidate.prepare('PRAGMA auto_vacuum').get() ?? {})[0]) !== 2) throw new Error('V5 storage pragmas were not applied.');
      candidate.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    } finally { candidate.close(); }
    privateDatabaseFiles(rewrite);
    fsyncPath(rewrite);
    source.close();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    renameSync(rewrite, path);
    privateDatabaseFiles(path);
    fsyncPath(root);
    return backup;
  } catch (error) {
    try { source.close(); } catch { /* preserve the migration error */ }
    rmSync(rewrite, { force: true });
    rmSync(`${rewrite}-wal`, { force: true });
    rmSync(`${rewrite}-shm`, { force: true });
    rmSync(backupTemporary, { force: true });
    throw error;
  } finally { releaseMaintenance?.(); }
};
