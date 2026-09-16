import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { componentPath, memoryDatabasePath, projectIdFrom, resolveProject, scopeRoot, sha256, trustedProjectIds } from '../src/workspace/project-identity.ts';

const writeIdentity = async (home: string, bindings: readonly { location: string; projectId: string }[], valid = true): Promise<void> => {
  const payload = { bindings };
  await mkdir(join(home, 'identity'), { recursive: true });
  await writeFile(join(home, 'identity', 'index.json'), JSON.stringify({
    schemaVersion: 1, revision: 1, contentHash: valid ? sha256(JSON.stringify(payload)) : '0'.repeat(64), payload,
  }));
};

test('project identity honors only a host-confirmed checkout locator', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const home = join(root, 'store');
  await mkdir(join(checkout, '.prjct'), { recursive: true });
  await writeFile(join(checkout, '.prjct', 'prjct.config.json'), JSON.stringify({ projectId: 'p_stable123456' }));

  const canonical = await realpath(checkout);
  assert.equal((await resolveProject(checkout, home)).projectId, projectIdFrom(canonical), 'an unbound locator is untrusted');
  await writeIdentity(home, [{ location: canonical, projectId: 'p_stable123456' }]);
  assert.equal((await resolveProject(checkout, home)).projectId, 'p_stable123456');
  assert.deepEqual(await trustedProjectIds(home), ['p_stable123456']);

  await writeIdentity(home, [{ location: canonical, projectId: 'p_stable123456' }], false);
  assert.equal((await resolveProject(checkout, home)).projectId, projectIdFrom(canonical), 'a corrupt index fails closed');
  assert.deepEqual(await trustedProjectIds(home), []);

  assert.match(projectIdFrom(checkout), /^p_[0-9a-f]{12}$/);
  assert.equal(componentPath(home, 'team', 'team_1'), join(home, 'teams', 'team_1', 'memory'));
  assert.equal(scopeRoot(home, 'shared', 'shared'), join(home, 'shared'));
  assert.equal(memoryDatabasePath(home, 'p_stable123456'), join(home, 'p_stable123456', 'memory', 'memory.sqlite'));
});
