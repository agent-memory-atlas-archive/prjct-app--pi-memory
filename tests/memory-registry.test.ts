import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import {
  initializeMemoryProject, initializeMemoryProjectWith, memoryProjectBindings, memoryRegistryPath,
  registeredMemoryProjectIds, resolveMemoryProject,
} from '../src/workspace/memory-registry.ts';
import { memoryHomeFor, projectIdFrom, sha256 } from '../src/workspace/project-identity.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const writeLegacyIdentity = async (home: string, location: string, projectId: string): Promise<void> => {
  const payload = { bindings: [{ location, projectId }] };
  await mkdir(join(home, 'identity'), { recursive: true });
  await writeFile(join(home, 'identity', 'index.json'), JSON.stringify({
    schemaVersion: 1, revision: 1, contentHash: sha256(JSON.stringify(payload)), payload,
  }));
};

test('memory home prefers explicit and neutral roots while retaining legacy fallbacks', () => {
  const memory = process.env.PI_MEMORY_HOME;
  const legacy = process.env.PRJCT_HOME;
  try {
    process.env.PI_MEMORY_HOME = '/tmp/pi-memory-neutral';
    process.env.PRJCT_HOME = '/tmp/pi-memory-legacy';
    assert.equal(memoryHomeFor(), '/tmp/pi-memory-neutral');
    assert.equal(memoryHomeFor('/tmp/pi-memory-explicit'), '/tmp/pi-memory-explicit');
    delete process.env.PI_MEMORY_HOME;
    assert.equal(memoryHomeFor(), '/tmp/pi-memory-legacy');
  } finally {
    if (memory === undefined) delete process.env.PI_MEMORY_HOME; else process.env.PI_MEMORY_HOME = memory;
    if (legacy === undefined) delete process.env.PRJCT_HOME; else process.env.PRJCT_HOME = legacy;
  }
});

test('registry lookup is read-only and concurrent initialization publishes one binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  assert.equal(await resolveMemoryProject(checkout, home), undefined);
  assert.deepEqual(await stat(home).catch(() => undefined), undefined);

  const claims = await Promise.all(Array.from({ length: 8 }, () => initializeMemoryProject(checkout, home)));
  assert.equal(claims.filter(claim => claim.created).length, 1);
  assert.ok(claims.every(claim => claim.binding.projectId === claims[0]!.binding.projectId));
  assert.deepEqual(await registeredMemoryProjectIds(home), [claims[0]!.binding.projectId]);
  assert.equal((await memoryProjectBindings(home)).length, 1);
  assert.equal((await stat(join(home, 'pi-memory'))).mode & 0o777, 0o700);
  assert.equal((await stat(memoryRegistryPath(home))).mode & 0o777, 0o600);
});

test('a process killed while holding the registry lock is recovered safely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-registry-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./registry-lock-child.mts', import.meta.url).pathname, checkout, home], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const output = { text: '' };
  await new Promise<void>((resolveLocked, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not acquire registry lock')), 10_000);
    child.stdout.on('data', chunk => {
      output.text += String(chunk);
      if (output.text.includes('locked')) { clearTimeout(timer); resolveLocked(); }
    });
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise(resolveExit => child.once('exit', resolveExit));
  const claim = await initializeMemoryProject(checkout, home);
  assert.equal(claim.created, true);
  const lockDatabase = await stat(join(home, 'pi-memory', 'projects.lock.sqlite'));
  assert.ok(lockDatabase.isFile());
  assert.equal(lockDatabase.mode & 0o777, 0o600);
});

test('a failed initializer cannot erase a later successful binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-registry-mixed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  const gate: { entered?: () => void; release?: () => void } = {};
  const entered = new Promise<void>(resolveEntered => { gate.entered = resolveEntered; });
  const release = new Promise<void>(resolveRelease => { gate.release = resolveRelease; });
  const first = initializeMemoryProjectWith(checkout, home, async () => {
    gate.entered?.();
    await release;
    throw new Error('injected initialization failure');
  });
  await entered;
  const second = initializeMemoryProjectWith(checkout, home, async () => 'ready');
  gate.release?.();
  await assert.rejects(first, /injected initialization failure/u);
  const initialized = await second;
  assert.equal(initialized.created, true);
  assert.equal(initialized.value, 'ready');
  assert.equal((await resolveMemoryProject(checkout, home))?.projectId, initialized.binding.projectId);
});

test('concurrent engine initialization creates one ready authority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-engine-concurrent-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  const initialized = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    MemoryEngine.initializeProject(checkout, `concurrent-${index}`, { home, provider: new TestEmbeddingProvider() })));
  assert.equal(initialized.filter(result => result.created).length, 1);
  assert.equal(new Set(initialized.map(result => result.binding.projectId)).size, 1);
  await Promise.all(initialized.map(result => result.engine.dispose()));
  const [projectId] = await registeredMemoryProjectIds(home);
  assert.ok(projectId);
  assert.ok((await stat(join(home, projectId, 'memory', 'memory.sqlite'))).isFile());
});

test('explicit engine initialization creates and reopens only a registered authority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-engine-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  await assert.rejects(() => MemoryEngine.forInitializedProject(checkout, 'before', { home }), /not initialized/u);
  const initialized = await MemoryEngine.initializeProject(checkout, 'init', { home, provider: new TestEmbeddingProvider() });
  assert.equal(initialized.created, true);
  await initialized.engine.dispose();
  const reopened = await MemoryEngine.forInitializedProject(checkout, 'after', { home, provider: new TestEmbeddingProvider() });
  assert.equal(reopened.scopeId, initialized.binding.projectId);
  await reopened.dispose();
});

test('forged legacy locators are ignored while verified legacy bindings are adopted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-legacy-adopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forged = join(root, 'forged');
  const verified = join(root, 'verified');
  const home = join(root, 'home');
  await mkdir(join(forged, '.prjct'), { recursive: true });
  await mkdir(join(verified, '.prjct'), { recursive: true });
  await writeFile(join(forged, '.prjct', 'prjct.config.json'), JSON.stringify({ projectId: 'p_forged' }));
  await writeFile(join(verified, '.prjct', 'prjct.config.json'), JSON.stringify({ projectId: 'p_legacy' }));
  const verifiedLocation = await realpath(verified);
  await writeLegacyIdentity(home, verifiedLocation, 'p_legacy');

  const forgedClaim = await initializeMemoryProject(forged, home);
  assert.equal(forgedClaim.binding.projectId, projectIdFrom(await realpath(forged)));
  assert.equal(forgedClaim.binding.source, 'memory');
  const legacyClaim = await initializeMemoryProject(verified, home);
  assert.equal(legacyClaim.binding.projectId, 'p_legacy');
  assert.equal(legacyClaim.binding.source, 'legacy');
});

test('corrupt and symlinked registries fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-registry-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  await initializeMemoryProject(checkout, home);
  const path = memoryRegistryPath(home);
  const envelope = JSON.parse(await readFile(path, 'utf8')) as { contentHash: string };
  await writeFile(path, JSON.stringify({ ...envelope, contentHash: '0'.repeat(64) }));
  await assert.rejects(() => resolveMemoryProject(checkout, home), /registry is corrupt/u);

  const linkedHome = join(root, 'linked-home');
  const outside = join(root, 'outside');
  await mkdir(linkedHome);
  await mkdir(outside);
  await symlink(outside, join(linkedHome, 'pi-memory'), 'dir');
  await assert.rejects(() => initializeMemoryProject(checkout, linkedHome), /outside|symbolic link/u);
});

test('a foreign database rolls back a new registry claim', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-registry-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'home');
  await mkdir(checkout);
  const projectId = projectIdFrom(await realpath(checkout));
  const memory = join(home, projectId, 'memory');
  await mkdir(memory, { recursive: true });
  const foreign = new MemoryEngine({ root: memory, scopeId: 'p_foreign', sessionId: 'foreign', provider: new TestEmbeddingProvider() });
  await foreign.dispose();
  await chmod(join(memory, 'memory.sqlite'), 0o600);

  await assert.rejects(() => MemoryEngine.initializeProject(checkout, 'init', {
    home, provider: new TestEmbeddingProvider(),
  }), /owner mismatch/u);
  assert.equal(await resolveMemoryProject(checkout, home), undefined);
  assert.deepEqual(await registeredMemoryProjectIds(home), []);
});
