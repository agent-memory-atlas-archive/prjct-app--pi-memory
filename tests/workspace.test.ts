import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { componentPath, projectIdFrom, resolveProject, scopeRoot } from '../src/workspace/project-identity.ts';

test('project identity converges independently and honors a moved-checkout locator', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(join(checkout, '.prjct'), { recursive: true });
  await writeFile(join(checkout, '.prjct', 'prjct.config.json'), JSON.stringify({ projectId: 'p_stable123456' }));
  assert.equal((await resolveProject(checkout)).projectId, 'p_stable123456');
  assert.match(projectIdFrom(checkout), /^p_[0-9a-f]{12}$/);
  assert.equal(componentPath(join(root, 'store'), 'team', 'team_1'), join(root, 'store', 'teams', 'team_1', 'memory'));
  assert.equal(scopeRoot(join(root, 'store'), 'shared', 'shared'), join(root, 'store', 'shared'));
});
