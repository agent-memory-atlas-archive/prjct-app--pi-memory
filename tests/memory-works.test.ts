import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { gitRoot, installMemoryHooks } from '../src/extension/hooks.ts';
import { installMemoryTools } from '../src/extension/tools.ts';
import { sessionFailureStatement } from '../src/sources/session-log.ts';
import { resolveMemoryProject } from '../src/workspace/memory-registry.ts';
import { TestEmbeddingProvider } from './helpers.ts';

process.env.PI_MEMORY_OFFLINE = '1';

type Handler = (event: any, ctx: any) => any;

const harness = async (t: { after(fn: () => unknown): void }, options: { git: boolean }) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-works-'));
  const repo = join(root, 'repo');
  const cwd = join(repo, 'packages', 'app');
  await mkdir(cwd, { recursive: true });
  if (options.git) await mkdir(join(repo, '.git'));
  const home = join(root, 'home');
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  const runtime = installMemoryHooks(pi, { home, embeddingProvider: new TestEmbeddingProvider() });
  installMemoryTools(pi, runtime);
  const ctx = { cwd, sessionManager: { getSessionId: () => 'works-session' }, getContextUsage: () => undefined };
  await handlers.get('session_start')!({}, ctx);
  t.after(async () => { await handlers.get('session_shutdown')!({}, ctx); await rm(root, { recursive: true, force: true }); });
  return { root, repo, cwd, home, handlers, tools, runtime, ctx };
};

test('a subdirectory resolves to its repository root, and home is never a repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-git-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'a', 'b'), { recursive: true });
  assert.equal(gitRoot(join(root, 'a', 'b')), root);
  assert.equal(gitRoot(tmpdir()), undefined);
  await rm(root, { recursive: true, force: true });
});

test('memory_record in an uninitialized git repository initializes it at the root and records', async t => {
  const h = await harness(t, { git: true });
  const lookupBefore = await h.tools.get('memory_context').execute('c0', { action: 'lookup', queries: ['package manager'] });
  assert.equal(lookupBefore.details.status, 'abstained');
  assert.match(lookupBefore.details.gaps.join(' '), /No memory has been recorded/);
  assert.equal(await resolveMemoryProject(h.repo, h.home), undefined, 'reading never initializes');

  const recorded = await h.tools.get('memory_record').execute('c1', {
    action: 'remember', kind: 'decision', statement: 'The workspace uses pnpm for local installs of every extension repository.',
  });
  assert.equal(recorded.details.status, 'ok');
  const binding = await resolveMemoryProject(h.repo, h.home);
  assert.ok(binding, 'the repository root, not the subdirectory, is bound');
  const found = await h.tools.get('memory_context').execute('c2', { action: 'lookup', queries: ['pnpm local installs'] });
  assert.equal(found.details.status, 'ok');
  assert.match(JSON.stringify(found.details.items), /pnpm/);
});

test('outside a git repository a record explains why and nothing is created', async t => {
  const h = await harness(t, { git: false });
  await assert.rejects(h.tools.get('memory_record').execute('c1', {
    action: 'remember', kind: 'decision', statement: 'Nothing should be written for a directory that is not a repository.',
  }), /git repository/);
  assert.equal(await resolveMemoryProject(h.cwd, h.home), undefined);
});

test('an agent-recorded memory recalls automatically in a later prompt, labelled needs_review', async t => {
  const h = await harness(t, { git: true });
  await h.tools.get('memory_record').execute('c1', {
    action: 'remember', kind: 'decision', statement: 'Compiled Pi builds live in the agent builds directory outside repositories.',
  });
  const result = await h.handlers.get('before_agent_start')!({ prompt: 'where do compiled Pi builds live?', systemPrompt: 'base' }, h.ctx);
  assert.ok(result.message, 'recall injected a memory block');
  assert.match(result.message.content, /Compiled Pi builds live/);
  assert.match(result.message.content, /needs_review/);
});

test('a remember declaration initializes repository memory; a tool failure alone does not', async t => {
  const failing = await harness(t, { git: true });
  await failing.handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'f1', isError: true,
    content: [{ type: 'text', text: 'Error: EACCES: permission denied, open /etc/hosts' }] }, failing.ctx);
  await failing.handlers.get('turn_end')!({}, failing.ctx);
  assert.equal(await resolveMemoryProject(failing.repo, failing.home), undefined);

  const declaring = await harness(t, { git: true });
  await declaring.handlers.get('before_agent_start')!({ prompt: 'recuerda que nunca publicamos releases sin avisar', systemPrompt: 'base' }, declaring.ctx);
  await declaring.handlers.get('turn_end')!({}, declaring.ctx);
  assert.ok(await resolveMemoryProject(declaring.repo, declaring.home));
  const found = await declaring.tools.get('memory_context').execute('c', { action: 'lookup', queries: ['publicamos releases'] });
  assert.match(JSON.stringify(found.details.items), /nunca publicamos releases/);
});

test('failure statements keep the diagnosis and drop red tests and runner framing', () => {
  const tap = 'bash failed\nTAP version 13\n# Subtest: layout\nnot ok 3 - layout\n  error: |-\n  code: ERR_ASSERTION\n  duration_ms: 27.1';
  assert.equal(sessionFailureStatement(tap), '');
  const env = 'bash failed\n> npm run build\nnpm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules\n    at Object.mkdir (node:fs:1)\nnpm error code EACCES';
  const statement = sessionFailureStatement(env);
  assert.equal(statement, 'bash: npm error code EACCES · npm error syscall mkdir · npm error path /usr/local/lib/node_modules');
  assert.equal(sessionFailureStatement('bash failed\nall good here'), '');
});

test('recorded memories get vectors in the background', async t => {
  const h = await harness(t, { git: true });
  await h.tools.get('memory_record').execute('c1', {
    action: 'remember', kind: 'preference', statement: 'Prefer measured numbers from real sessions over estimates in reports.',
  });
  const engine = await h.runtime.engine();
  const deadline = Date.now() + 5_000;
  while (engine.projection.stats().vectors === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(engine.projection.stats().vectors > 0);
});

test('memory tools are hidden outside repositories and restored inside one', async t => {
  const { installMemory } = await import('../src/index.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-visibility-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  const plain = join(root, 'plain');
  await mkdir(plain);
  const handlers = new Map<string, Handler[]>();
  const state = { active: ['read', 'bash', 'memory_context', 'memory_record'] };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool() {}, registerCommand() {},
    getActiveTools: () => state.active, setActiveTools: (next: string[]) => { state.active = next; },
  } as unknown as ExtensionAPI;
  installMemory(pi, { home: join(root, 'home') });
  const start = async (cwd: string) => {
    for (const handler of handlers.get('session_start') ?? []) await handler({}, { cwd, sessionManager: { getSessionId: () => `s-${cwd}` } });
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  await start(plain);
  assert.deepEqual(state.active, ['read', 'bash']);
  await start(repo);
  assert.deepEqual(state.active, ['read', 'bash', 'memory_context', 'memory_record']);
  for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, {});
});

test('recall searches the question inside an instruction-wrapped prompt', async () => {
  const { recallQueries } = await import('../src/extension/hooks.ts');
  assert.deepEqual(recallQueries('¿Qué gestor de paquetes usamos en este repo? Responde en una línea, sin leer archivos.'), [
    '¿Qué gestor de paquetes usamos en este repo? Responde en una línea, sin leer archivos.',
    '¿Qué gestor de paquetes usamos en este repo?',
    'Responde en una línea, sin leer archivos.',
  ]);
  assert.equal(recallQueries('a\nb\nc\nd\ne\nfive longer sentences here\nsix longer sentences here\nseven longer sentences here\neight longer ones').length, 4);
});

test('a close and distinctive dense match passes the relevance gate for a long natural question', async () => {
  const { relevantKeys } = await import('../src/retrieval/relevance.ts');
  const statistics = { documents: 3, frequencies: new Map<string, number>() } as never;
  const candidates = [
    { key: 'builds', text: 'Compiled Pi extension builds live in the agent builds directory, outside repositories.' },
    { key: 'pnpm', text: 'The workspace uses pnpm for installs.' },
    { key: 'theme', text: 'The editor theme is dark.' },
  ];
  const query = '¿Dónde viven los artefactos compilados de las extensiones? Responde en una línea.';
  assert.deepEqual([...relevantKeys(query, candidates, statistics, new Map([['builds', 0.69], ['pnpm', 0.04], ['theme', 0.01]]))], ['builds']);
  assert.deepEqual([...relevantKeys(query, candidates, statistics, new Map([['builds', 0.69], ['pnpm', 0.62], ['theme', 0.61]]))], [],
    'an encoder that scores everything alike proves nothing');
  assert.deepEqual([...relevantKeys(query, candidates, statistics, new Map([['builds', 0.69]]))], [], 'one scored candidate cannot show discrimination');
});
