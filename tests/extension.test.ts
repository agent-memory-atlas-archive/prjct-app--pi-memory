import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMemory, type MemoryExtensionOptions } from '../src/index.ts';
import { installMemoryHooks } from '../src/extension/hooks.ts';

type Handler = (event: any, ctx: any) => Promise<any>;
const hookHarness = (): { runtime: ReturnType<typeof installMemoryHooks>; handlers: Map<string, Handler> } => {
  const handlers = new Map<string, Handler>();
  const pi = { on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const runtime = installMemoryHooks(pi);
  return { runtime, handlers };
};

test('installs only Pi-native hooks, tools and commands', () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(definition: { name: string }) { tools.push(definition.name); },
    registerCommand(name: string) { commands.push(name); },
    on(name: string) { events.push(name); },
  } as unknown as ExtensionAPI;
  installMemory(pi);
  assert.deepEqual(tools, ['memory_context', 'memory_record']);
  assert.deepEqual(commands, ['memory']);
  assert.deepEqual(events, ['session_start', 'before_agent_start', 'tool_result', 'model_select', 'context', 'before_provider_request', 'session_shutdown']);
});

test('explicit public handoff budget reaches the controller', () => {
  const handlers = new Map<string, Handler>();
  const pi = { on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const handoff = { maxTokens: 3210, maxBytes: 6543, maxMessages: 7, toolSchemaReserveTokens: 222 } as const;
  const publicOptions: MemoryExtensionOptions = { handoff };
  const runtime = installMemoryHooks(pi, { handoff: publicOptions.handoff });
  assert.deepEqual(runtime.handoff.budget, handoff);
});

test('host tool results expose session-local evidence ids to the active agent', async () => {
  const { runtime, handlers } = hookHarness();
  const content = [{ type: 'text', text: 'npm test passed' }];
  const patched = await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'call_1', isError: false, content },
    { sessionManager: { getSessionId: () => 'session_1' } });
  const marker = patched.content.at(-1).text as string;
  assert.match(marker, /^\[pi-memory evidence: ev_[a-z0-9_-]+\]$/);
  const id = marker.slice('[pi-memory evidence: '.length, -1);
  assert.equal(runtime.stagedEvidence().get(id)?.excerpt, 'bash succeeded\nnpm test passed');
});

test('memory tool results do not stage evidence and staged excerpts are redacted', async () => {
  const { runtime, handlers } = hookHarness();
  const ctx = { sessionManager: { getSessionId: () => 'session_1' } };
  // Both memory tools must be excluded, not just the one that happened to be
  // covered: memory_record is in the production condition too.
  for (const toolName of ['memory_context', 'memory_record']) {
    assert.equal(await handlers.get('tool_result')!({ toolName, toolCallId: 'call_0', isError: false, content: [] }, ctx), undefined);
  }
  assert.equal(runtime.stagedEvidence().size, 0);
  const patched = await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'call_1', isError: true,
    content: [{ type: 'text', text: 'Authorization: Bearer abcdefghijklmnop' }] }, ctx);
  const id = (patched.content.at(-1).text as string).slice('[pi-memory evidence: '.length, -1);
  const excerpt = runtime.stagedEvidence().get(id)?.excerpt ?? '';
  assert.equal(excerpt.includes('abcdefghijklmnop'), false);
  assert.match(excerpt, /<REDACTED>/);
});

test('automatic recall preserves evidence already bounded by retrieval instead of clipping it twice', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { TestEmbeddingProvider } = await import('./helpers.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-auto-'));
  const handlers = new Map<string, Handler>();
  const pi = { on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const runtime = installMemoryHooks(pi, { home: join(root, 'home'), federate: false });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'automatic-test' } };
  await handlers.get('session_start')!({}, ctx);
  t.after(async () => { await handlers.get('session_shutdown')!({}, ctx); await rm(root, { recursive: true, force: true }); });
  const engine = await runtime.engine();
  // Stub only the external encoder boundary; indexing, lookup, budgets and the
  // actual before_agent_start handler remain real.
  const provider = new TestEmbeddingProvider();
  engine.vector.provider.embed = provider.embed.bind(provider);
  const text = `SQLite backup policy. ${'Detailed operational evidence. '.repeat(20)}Decision: preserve the WAL.`;
  await engine.recordFact({ kind: 'procedure', statement: text.slice(0, 8000), entities: [], evidence: [], episodeIds: [],
    confidence: 0.9, tags: { area: 'backup' } });
  const response = await handlers.get('before_agent_start')!({ prompt: 'SQLite backup', systemPrompt: 'Base rules.' }, ctx);
  assert.match(response.systemPrompt, /Decision: preserve the WAL/);
});
