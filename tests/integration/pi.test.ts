import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const pi = process.env.PI_BIN ?? 'pi';

test('Pi keeps status read-only until explicit /memory init and then reopens the authority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project, { recursive: true });
  const child = spawn(pi, ['--mode', 'rpc', '--no-session', '--no-extensions', '-e', resolve('index.ts')], {
    cwd: project,
    env: { ...process.env, PI_MEMORY_HOME: home, PRJCT_HOME: join(root, 'ignored-legacy-home') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const records: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const pending = new Map<string, (record: Record<string, unknown>) => void>();
  const buffered = { text: '' };
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  child.stdout.on('data', chunk => {
    buffered.text += String(chunk);
    const lines = buffered.text.split('\n');
    buffered.text = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const record = JSON.parse(line) as Record<string, unknown>;
      records.push(record);
      if (record.type === 'response' && typeof record.id === 'string') pending.get(record.id)?.(record);
    }
  });
  const send = (id: string, message: string): Promise<Record<string, unknown>> => new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout for ${id}`)), 30_000);
    pending.set(id, record => { clearTimeout(timer); pending.delete(id); resolveResponse(record); });
    child.stdin.write(`${JSON.stringify({ id, type: 'prompt', message })}\n`);
  });
  const noticesAfter = (offset: number): { next: number; messages: string[] } => {
    const messages = records.slice(offset).flatMap(record => record.type === 'extension_ui_request'
      && record.method === 'notify' && typeof record.message === 'string' ? [record.message] : []);
    return { next: records.length, messages };
  };

  const status = await send('status-before', '/memory status');
  assert.equal(status.success, true);
  const before = noticesAfter(0);
  assert.ok(before.messages.some(message => message.includes('initialized no')));
  assert.deepEqual(await readdir(home).catch(() => []), [], 'read-only status must not create the home or authority');

  const initialized = await send('init', '/memory init');
  assert.equal(initialized.success, true);
  const afterInit = noticesAfter(before.next);
  assert.ok(afterInit.messages.some(message => message.includes('status initialized')));
  const scopes = await readdir(home);
  const projectId = scopes.find(entry => /^p_[0-9a-f]{12}$/u.test(entry));
  assert.ok(projectId);
  assert.ok((await stat(join(home, 'pi-memory', 'projects.json'))).isFile());
  assert.ok((await stat(join(home, projectId, 'memory', 'memory.sqlite'))).isFile());

  const reopened = await send('status-after', '/memory status');
  assert.equal(reopened.success, true);
  const afterStatus = noticesAfter(afterInit.next);
  assert.ok(afterStatus.messages.some(message => message.includes('memory · status') && message.includes('facts 0')));

  child.stdin.end();
  const exit = await new Promise<number | null>(resolveExit => child.on('exit', resolveExit));
  assert.equal(exit, 0, stderr.join(''));
});
