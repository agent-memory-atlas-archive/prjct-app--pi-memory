import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  assertProjectLocalPath, checkoutIdFrom, memoryHomeFor, projectIdFrom, resolveLegacyProject, sha256,
} from './project-identity.ts';

export const MEMORY_REGISTRY_DIRECTORY = 'pi-memory';
export const MEMORY_REGISTRY_FILE = 'projects.json';
const MAX_REGISTRY_BYTES = 1_048_576;
const LOCK_WAIT_MS = 30_000;
const localRegistryLocks = new Map<string, Promise<void>>();

export type MemoryProjectBinding = Readonly<{
  location: string;
  projectId: string;
  checkoutId: string;
  source: 'memory' | 'legacy';
  createdAt: string;
}>;

type RegistryPayload = Readonly<{ bindings: readonly MemoryProjectBinding[] }>;
type RegistryEnvelope = Readonly<{
  schemaVersion: 1;
  revision: number;
  contentHash: string;
  payload: RegistryPayload;
}>;

export type MemoryProjectClaim = Readonly<{ binding: MemoryProjectBinding; created: boolean; revision: number }>;

export const memoryRegistryPath = (home = memoryHomeFor()): string =>
  join(resolve(home), MEMORY_REGISTRY_DIRECTORY, MEMORY_REGISTRY_FILE);

const validBinding = (value: unknown): value is MemoryProjectBinding => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<MemoryProjectBinding>;
  return typeof row.location === 'string' && isAbsolute(row.location) && resolve(row.location) === row.location
    && typeof row.projectId === 'string' && /^p_[A-Za-z0-9_-]+$/u.test(row.projectId)
    && typeof row.checkoutId === 'string' && /^co_[A-Za-z0-9_-]+$/u.test(row.checkoutId)
    && (row.source === 'memory' || row.source === 'legacy')
    && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt));
};

const parseRegistry = (raw: string): RegistryEnvelope => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid envelope');
    const envelope = value as Partial<RegistryEnvelope>;
    if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) || Number(envelope.revision) < 1
      || typeof envelope.contentHash !== 'string' || !envelope.payload || typeof envelope.payload !== 'object'
      || Array.isArray(envelope.payload) || !Array.isArray(envelope.payload.bindings)
      || sha256(JSON.stringify(envelope.payload)) !== envelope.contentHash
      || !envelope.payload.bindings.every(validBinding)) throw new Error('invalid envelope');
    const locations = envelope.payload.bindings.map(binding => binding.location);
    if (new Set(locations).size !== locations.length) throw new Error('duplicate checkout binding');
    return envelope as RegistryEnvelope;
  } catch {
    throw new Error('The pi-memory project registry is corrupt; refusing to infer or create another authority.');
  }
};

const assertRegistryPath = async (home: string, path: string): Promise<void> => {
  if (!existsSync(home)) return;
  assertProjectLocalPath(home, path);
  const directory = dirname(path);
  const directoryInfo = await lstat(directory).catch(() => undefined);
  if (directoryInfo?.isSymbolicLink()) throw new Error('The pi-memory registry directory cannot be a symbolic link.');
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new Error('The pi-memory project registry cannot be a symbolic link.');
  if (info && (!info.isFile() || info.size > MAX_REGISTRY_BYTES)) throw new Error('The pi-memory project registry is invalid or too large.');
};

const readEnvelope = async (home: string): Promise<RegistryEnvelope | undefined> => {
  const authorityHome = resolve(home);
  const path = memoryRegistryPath(authorityHome);
  await assertRegistryPath(authorityHome, path);
  const raw = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return raw === undefined ? undefined : parseRegistry(raw);
};

export const memoryProjectBindings = async (home = memoryHomeFor()): Promise<readonly MemoryProjectBinding[]> =>
  (await readEnvelope(home))?.payload.bindings ?? [];

export const registeredMemoryProjectIds = async (home = memoryHomeFor()): Promise<readonly string[]> =>
  [...new Set((await memoryProjectBindings(home)).map(binding => binding.projectId))].sort();

export const resolveMemoryProject = async (cwd: string, home = memoryHomeFor()): Promise<MemoryProjectBinding | undefined> => {
  const location = await realpath(resolve(cwd));
  return (await memoryProjectBindings(home)).find(binding => binding.location === location);
};

const acquireRegistryLock = async (root: string): Promise<() => Promise<void>> => {
  const path = join(root, 'projects.lock.sqlite');
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink() || (info && !info.isFile())) throw new Error('The pi-memory project registry lock is invalid.');
  const database = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    database.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}; CREATE TABLE IF NOT EXISTS registry_lock (singleton INTEGER PRIMARY KEY); BEGIN IMMEDIATE`);
    return async () => { try { database.exec('COMMIT'); } finally { database.close(); } };
  } catch (error) {
    database.close();
    throw error;
  }
};

const withRegistryLock = async <T>(home: string, action: () => Promise<T>): Promise<T> => {
  const authorityHome = resolve(home);
  await mkdir(authorityHome, { recursive: true, mode: 0o700 });
  const root = join(authorityHome, MEMORY_REGISTRY_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  assertProjectLocalPath(authorityHome, root);
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('The pi-memory registry directory cannot be a symbolic link.');
  await chmod(root, 0o700);
  const lockKey = await realpath(root);
  const previous = localRegistryLocks.get(lockKey) ?? Promise.resolve();
  const gate: { release?: () => void } = {};
  const current = new Promise<void>(resolveGate => { gate.release = resolveGate; });
  const queued = previous.then(() => current);
  localRegistryLocks.set(lockKey, queued);
  await previous;
  try {
    const release = await acquireRegistryLock(root);
    try { return await action(); }
    finally { await release(); }
  } finally {
    gate.release?.();
    if (localRegistryLocks.get(lockKey) === queued) localRegistryLocks.delete(lockKey);
  }
};

const writeEnvelope = async (home: string, bindings: readonly MemoryProjectBinding[], revision: number): Promise<void> => {
  const path = memoryRegistryPath(home);
  const payload: RegistryPayload = { bindings: [...bindings].sort((left, right) => left.location.localeCompare(right.location)) };
  const envelope: RegistryEnvelope = { schemaVersion: 1, revision, contentHash: sha256(JSON.stringify(payload)), payload };
  const encoded = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REGISTRY_BYTES) throw new Error('The pi-memory project registry exceeds its size limit.');
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    parseRegistry(await readFile(temp, 'utf8'));
    await rename(temp, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

export const initializeMemoryProjectWith = async <T>(cwd: string, home: string,
  prepare: (binding: MemoryProjectBinding) => Promise<T>): Promise<Readonly<MemoryProjectClaim & { value: T }>> => {
  const authorityHome = resolve(home);
  return withRegistryLock(authorityHome, async () => {
    const location = await realpath(resolve(cwd));
    const current = await readEnvelope(authorityHome);
    const existing = current?.payload.bindings.find(binding => binding.location === location);
    if (existing) {
      const value = await prepare(existing);
      return { binding: existing, created: false, revision: current!.revision, value };
    }
    const legacy = await resolveLegacyProject(location, authorityHome);
    const projectId = legacy?.projectId ?? projectIdFrom(location);
    const collision = current?.payload.bindings.find(binding => binding.projectId === projectId && binding.location !== location);
    if (collision && !legacy) throw new Error('The derived pi-memory project id collides with another registered checkout.');
    const binding: MemoryProjectBinding = {
      location, projectId, checkoutId: checkoutIdFrom(location), source: legacy ? 'legacy' : 'memory',
      createdAt: new Date().toISOString(),
    };
    const value = await prepare(binding);
    const revision = (current?.revision ?? 0) + 1;
    await writeEnvelope(authorityHome, [...(current?.payload.bindings ?? []), binding], revision);
    return { binding, created: true, revision, value };
  });
};

export const initializeMemoryProject = async (cwd: string, home = memoryHomeFor()): Promise<MemoryProjectClaim> => {
  const initialized = await initializeMemoryProjectWith(cwd, home, async () => undefined);
  return { binding: initialized.binding, created: initialized.created, revision: initialized.revision };
};
