import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMemory } from '../src/index.ts';

test('memory commands require explicit initialization and reject empty checkpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-commands-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const hooks = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) { hooks.set(name, handler); },
    registerTool() {},
    registerCommand(name: string, definition: { handler(args: string, ctx: any): Promise<void> }) {
      commands.set(name, definition.handler);
    },
  } as unknown as ExtensionAPI;
  installMemory(pi, { home });
  const notices: string[] = [];
  const ctx = {
    cwd: root, mode: 'rpc', hasUI: false,
    sessionManager: { getSessionId: () => 'command-session' },
    ui: { notify(message: string) { notices.push(message); } },
  };
  await hooks.get('session_start')!({}, ctx);
  t.after(() => hooks.get('session_shutdown')!({}, ctx));
  const command = commands.get('memory')!;

  await command('status', ctx);
  assert.equal((JSON.parse(notices.at(-1) ?? '{}') as { initialized?: boolean }).initialized, false);
  assert.deepEqual(await readdir(home).catch(() => []), []);
  await assert.rejects(() => command('unknown', ctx), /Usage: \/memory init/u);
  assert.deepEqual(await readdir(home).catch(() => []), []);

  await command('init', ctx);
  assert.equal((JSON.parse(notices.at(-1) ?? '{}') as { status?: string }).status, 'initialized');
  const entries = await readdir(home);
  const projectId = entries.find(entry => /^p_[0-9a-f]{12}$/u.test(entry));
  assert.ok(projectId);
  assert.ok((await stat(join(home, projectId, 'memory', 'memory.sqlite'))).isFile());

  await command('status', ctx);
  assert.equal((JSON.parse(notices.at(-1) ?? '{}') as { facts?: number }).facts, 0);
  await assert.rejects(() => command('checkpoint {}', ctx), /non-empty goal/u);
});
