import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMemory } from '../src/index.ts';
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
  assert.deepEqual(events, ['session_start', 'before_agent_start', 'tool_result', 'session_shutdown']);
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
  const memoryResult = await handlers.get('tool_result')!({ toolName: 'memory_context', toolCallId: 'call_0', isError: false, content: [] }, ctx);
  assert.equal(memoryResult, undefined);
  const patched = await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'call_1', isError: true,
    content: [{ type: 'text', text: 'Authorization: Bearer abcdefghijklmnop' }] }, ctx);
  const id = (patched.content.at(-1).text as string).slice('[pi-memory evidence: '.length, -1);
  const excerpt = runtime.stagedEvidence().get(id)?.excerpt ?? '';
  assert.equal(excerpt.includes('abcdefghijklmnop'), false);
  assert.match(excerpt, /<REDACTED>/);
});
