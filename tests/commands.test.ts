import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider, type AutocompleteItem } from '@earendil-works/pi-tui';
import { installMemory } from '../src/index.ts';

type CommandDefinition = Readonly<{
  handler(args: string, ctx: any): Promise<void>;
  getArgumentCompletions?(prefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}>;

test('memory command completes every action and configured sync adapter without opening storage', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-memory-completions-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const home = join(rootDir, 'home');
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    on() {}, registerTool() {},
    registerCommand(name: string, definition: CommandDefinition) { commands.set(name, definition); },
  } as unknown as ExtensionAPI;
  installMemory(pi, { home, sources: {
    prjct: {},
    extra: [
      { id: 'custom-json', scope: { kind: 'project', id: 'p_example' }, scan: async () => [] },
      { id: 'unsafe\u001b[2J', scope: { kind: 'project', id: 'p_example' }, scan: async () => [] },
    ],
  } });
  const complete = commands.get('memory')?.getArgumentCompletions;
  assert.ok(complete);
  const values = async (prefix: string): Promise<string[] | null> => {
    const items = await complete(prefix);
    return items?.map(item => item.value) ?? null;
  };
  assert.deepEqual(await values(''), [
    'init', 'status', 'sources', 'sync', 'index', 'checkpoint', 'replay', 'rebuild', 'gc',
    'checkpoint-wal', 'migrate-curated',
  ]);
  assert.deepEqual(await values('st'), ['status']);
  assert.deepEqual(await values('s'), ['status', 'sources', 'sync']);
  assert.deepEqual(await values('sync '), ['sync custom-json', 'sync pi-session', 'sync prjct-observations']);
  assert.deepEqual(await values('sync p'), ['sync pi-session', 'sync prjct-observations']);
  assert.equal(await values('sync missing'), null);
  assert.equal(await values('index {'), null, 'JSON input must remain under direct editor control');
  const root = await complete('');
  assert.ok(root?.every(item => item.description));

  const provider = new CombinedAutocompleteProvider([{ name: 'memory', getArgumentCompletions: complete }], rootDir);
  const suggestions = await provider.getSuggestions(['/memory sync p'], 0, '/memory sync p'.length, {
    signal: AbortSignal.timeout(1_000),
  });
  assert.deepEqual(suggestions?.items.map(item => item.value), ['sync pi-session', 'sync prjct-observations']);
  const selected = suggestions?.items[0];
  assert.ok(selected);
  assert.deepEqual(provider.applyCompletion(['/memory sync p'], 0, '/memory sync p'.length, selected,
    suggestions?.prefix ?? ''), { lines: ['/memory sync pi-session'], cursorLine: 0, cursorCol: 23 });
  assert.deepEqual(await readdir(home).catch(() => []), []);
});

test('memory commands require explicit initialization and reject empty checkpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-commands-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const hooks = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) { hooks.set(name, handler); },
    registerTool() {},
    registerCommand(name: string, definition: CommandDefinition) { commands.set(name, definition); },
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
  const command = commands.get('memory')!.handler;

  await command('status', ctx);
  assert.match(notices.at(-1) ?? '', /initialized no/u);
  assert.doesNotMatch(notices.at(-1) ?? '', /"initialized"/u);
  assert.deepEqual(await readdir(home).catch(() => []), []);
  await assert.rejects(() => command('unknown', ctx), /Usage: \/memory init/u);
  assert.deepEqual(await readdir(home).catch(() => []), []);

  await command('init', ctx);
  assert.match(notices.at(-1) ?? '', /status initialized/u);
  const entries = await readdir(home);
  const projectId = entries.find(entry => /^p_[0-9a-f]{12}$/u.test(entry));
  assert.ok(projectId);
  assert.ok((await stat(join(home, projectId, 'memory', 'memory.sqlite'))).isFile());

  await command('status', ctx);
  assert.match(notices.at(-1) ?? '', /facts 0/u);

  await command('sync', ctx);
  assert.match(notices.at(-1) ?? '', /memory · sync/u);
  assert.doesNotMatch(notices.at(-1) ?? '', /"discovered"/u);

  const tui = {
    ...ctx, mode: 'tui', hasUI: true,
    ui: {
      notify(message: string) { notices.push(message); },
      async custom() {
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      },
    },
  };
  await command('status', tui);
  assert.match(notices.at(-1) ?? '', /facts 0/u);
  assert.doesNotMatch(notices.at(-1) ?? '', /Operation aborted/u);

  await assert.rejects(() => command('checkpoint {}', ctx), /non-empty goal/u);
});
