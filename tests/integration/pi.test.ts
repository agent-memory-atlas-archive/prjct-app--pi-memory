import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const pi = process.env.PI_BIN ?? 'pi';

test('Pi loads the package and executes /memory status without an LLM provider call', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project, { recursive: true });
  const child = spawn(pi, ['--mode', 'rpc', '--no-session', '--no-extensions', '-e', resolve('index.ts')], {
    cwd: project,
    env: { ...process.env, PRJCT_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  child.stdin.end(JSON.stringify({ id: 'memory', type: 'prompt', message: '/memory status' }) + '\n');
  const exit = await new Promise<number | null>(resolveExit => child.on('exit', resolveExit));
  assert.equal(exit, 0, stderr.join(''));
  const output = stdout.join('');
  const records = output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.ok(records.some(record => record.type === 'response' && record.id === 'memory' && record.success === true));
  const notice = records.find(record => record.type === 'extension_ui_request' && record.method === 'notify') as { message?: string } | undefined;
  assert.ok(notice?.message, 'the command published a UI notification');
  const stats = JSON.parse(notice.message) as Record<string, unknown>;
  assert.equal(stats.documents, 0);
  assert.equal(stats.vectors, 0);
  const scopes = await readdir(home);
  assert.equal(scopes.length, 1);
  assert.match(scopes[0]!, /^p_[0-9a-f]{12}$/);
  assert.ok((await stat(join(home, scopes[0]!, 'memory', 'memory.sqlite'))).isFile());
});
