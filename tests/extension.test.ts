import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMemory } from '../src/index.ts';
import { installMemoryHooks } from '../src/extension/hooks.ts';

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
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const pi = { on(name: string, handler: (event: any, ctx: any) => Promise<any>) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const runtime = installMemoryHooks(pi);
  const content = [{ type: 'text', text: 'npm test passed' }];
  const patched = await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'call_1', isError: false, content },
    { sessionManager: { getSessionId: () => 'session_1' } });
  const marker = patched.content.at(-1).text as string;
  assert.match(marker, /^\[pi-memory evidence: ev_[a-z0-9_-]+\]$/);
  const id = marker.slice('[pi-memory evidence: '.length, -1);
  assert.equal(runtime.stagedEvidence().get(id)?.excerpt, 'bash succeeded\nnpm test passed');
});
