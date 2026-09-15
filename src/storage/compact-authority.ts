import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { assertProjectId } from '../workspace/project-identity.ts';

export type CompactValue = null | boolean | number | string | readonly CompactValue[] | { readonly [key: string]: CompactValue };
export type CompactState = Readonly<Record<string, CompactValue>>;
export type CompactSnapshot = Readonly<{ revision: number; state: CompactState }>;
export type CompactWrite = Readonly<{ status: 'committed' | 'stale'; revision: number }> | Readonly<{ status: 'busy' }>;

const FORMAT = 1; // Brotli q5, lossless JSON, owner-bound digest.
const MAX_RAW_BYTES = 512 * 1024;
const MAX_ENCODED_BYTES = 14 * 1024;
const MAX_PAGES = 32;
const empty = Object.freeze({});

export class CompactCapacityError extends Error {}
export class CompactFormatError extends Error {}

const busy = (error: unknown): boolean => /database (?:table )?is locked|SQLITE_BUSY|SQLITE_LOCKED/iu.test(String(error));
const hash = (owner: string, bytes: Uint8Array): Buffer => createHash('sha256').update(owner).update('\0').update(bytes).digest();
const freeze = (value: CompactValue): void => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
};
const validate = (value: unknown, depth = 0): void => {
  if (depth > 128 || (typeof value === 'string' && value.length > MAX_RAW_BYTES)) throw new CompactCapacityError('Compact value exceeds decode capacity.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  // JSON.stringify turns an undefined ARRAY element into null, which is lossy,
  // but simply omits an undefined object property, which matches an absent key.
  if (Array.isArray(value)) { for (const item of value) validate(item, depth + 1); return; }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    Object.values(value).forEach(item => { if (item !== undefined) validate(item, depth + 1); }); return;
  }
  throw new CompactFormatError('Compact state must contain only lossless JSON values.');
};

/** Foundation only: not routed from MemoryEngine until domain adapters and
 * atomic indexed promotion pass equivalence tests. Existing indexed stores are
 * explicitly refused, never migrated by this class.
 */
export class CompactAuthority {
  private readonly db: DatabaseSync;
  private readonly owner: string;
  private cache: CompactSnapshot | undefined;

  constructor(readonly path: string, projectId: string) {
    this.owner = assertProjectId(projectId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      // Connection-local settings only. Opening a populated compact authority
      // does not create schema, checkpoint or rewrite persistent PRAGMAs.
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA cache_spill=OFF');
      const exists = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='compact_authority'").get();
      if (!exists) {
        if (this.db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) throw new CompactFormatError('Not a compact authority format.');
        this.initialize();
      }
      for (const [name, expected] of [['page_size', 512], ['auto_vacuum', 1], ['journal_mode', 'wal'], ['synchronous', 2]] as const) {
        if (Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0] !== expected) throw new CompactFormatError(`Invalid compact ${name}.`);
      }
      this.read();
    } catch (error) { this.db.close(); throw error; }
  }

  private initialize(): void {
    // These settings are chosen before the first schema object, on this same
    // connection. FULL auto-vacuum prevents old overflow chains doubling size.
    this.db.exec('PRAGMA page_size=512; PRAGMA auto_vacuum=FULL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    const encoded = this.encode(empty);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS compact_authority(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,format INTEGER NOT NULL,mode INTEGER NOT NULL,revision INTEGER NOT NULL,digest BLOB NOT NULL,state BLOB NOT NULL)');
      this.db.prepare('INSERT OR IGNORE INTO compact_authority VALUES (1,?,?,0,0,?,?)').run(this.owner, FORMAT, hash(this.owner, encoded), encoded);
      this.row(); // Owner check also fences competing first-open claims.
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.checkpoint();
  }

  private encode(state: CompactState): Buffer {
    if (!state || Array.isArray(state) || typeof state !== 'object') throw new CompactFormatError('Invalid compact state root.');
    validate(state);
    const raw = Buffer.from(JSON.stringify(state));
    if (raw.length > MAX_RAW_BYTES) throw new CompactCapacityError('Compact raw capacity requires indexed promotion.');
    const encoded = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
    // Conservative overflow-page allowance includes owner/checksum/row headers,
    // catalog, table root and auto-vacuum pointer map. No SQL mutation yet.
    const estimatedPages = 3 + Math.ceil((encoded.length + Buffer.byteLength(this.owner) + 128) / 480);
    if (encoded.length > MAX_ENCODED_BYTES || estimatedPages > MAX_PAGES) {
      throw new CompactCapacityError('Compact encoded capacity requires indexed promotion.');
    }
    return encoded;
  }

  private row(): { revision: number; bytes: Uint8Array } {
    const row = this.db.prepare('SELECT owner,format,mode,revision,digest,state FROM compact_authority WHERE id=1').get();
    if (row?.owner !== this.owner) throw new CompactFormatError('Compact authority owner mismatch.');
    if (row.format !== FORMAT || row.mode !== 0) throw new CompactFormatError('Unsupported compact format/mode; reroute to the indexed authority.');
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !(row.state instanceof Uint8Array)
      || row.state.length > MAX_ENCODED_BYTES || !(row.digest instanceof Uint8Array)
      || !hash(this.owner, row.state).equals(row.digest)) throw new CompactFormatError('Corrupt compact authority state.');
    return { revision: Number(row.revision), bytes: row.state };
  }

  read(): CompactSnapshot {
    const row = this.row();
    if (this.cache?.revision === row.revision) return this.cache;
    const state: unknown = JSON.parse(brotliDecompressSync(row.bytes, { maxOutputLength: MAX_RAW_BYTES }).toString('utf8'));
    if (!state || Array.isArray(state) || typeof state !== 'object') throw new CompactFormatError('Invalid compact state root.');
    validate(state); freeze(state as CompactState);
    this.cache = Object.freeze({ revision: row.revision, state: state as CompactState });
    return this.cache;
  }

  private walBytes(): number { return statSync(`${this.path}-wal`, { throwIfNoEntry: false })?.size ?? 0; }

  checkpoint(): 'checkpointed' | 'busy' {
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      return result?.busy ? 'busy' : 'checkpointed';
    } catch (error) { if (busy(error)) return 'busy'; throw error; }
  }

  compareAndSwap(expectedRevision: number, state: CompactState): CompactWrite {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new CompactFormatError('Invalid compact expected revision.');
    }
    const encoded = this.encode(state);
    if (this.walBytes() > 0 && this.checkpoint() === 'busy') return { status: 'busy' };
    const lock = { held: false };
    try {
      this.db.exec('BEGIN IMMEDIATE'); lock.held = true;
      // Another process can commit between our checkpoint and lock acquisition.
      // Never append a second snapshot behind a pinned reader or that race.
      if (this.walBytes() > 0) return { status: 'busy' };
      const current = this.row();
      if (current.revision !== expectedRevision) return { status: 'stale', revision: current.revision };
      const pages = Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
      if (pages > MAX_PAGES) throw new CompactCapacityError('Existing compact pages require indexed promotion.');
      const revision = expectedRevision + 1;
      this.db.prepare('UPDATE compact_authority SET revision=?,digest=?,state=? WHERE id=1 AND revision=?')
        .run(revision, hash(this.owner, encoded), encoded, expectedRevision);
      this.db.exec('COMMIT'); lock.held = false; this.cache = undefined;
      return { status: 'committed', revision };
    } catch (error) { if (busy(error)) return { status: 'busy' }; throw error; }
    finally { if (lock.held) this.db.exec('ROLLBACK'); }
  }

  close(): void { this.db.close(); }
}
