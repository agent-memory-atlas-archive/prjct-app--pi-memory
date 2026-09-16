import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMemoryHooks } from '../src/extension/hooks.ts';
import { registerKnownSources } from '../src/sources/install.ts';
import { piSessionSource } from '../src/sources/presets.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import {
  appendSessionObservation, clipSessionSummary, sessionLogRoot, sessionObservationWorthy,
} from '../src/sources/session-log.ts';
import { MemoryEngine } from '../src/engine.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const ctx = (cwd: string, sessionId = 's1') => ({
  cwd, sessionManager: { getSessionId: () => sessionId }, getContextUsage: () => ({ tokens: 0 }),
});

test('session log keeps failures and corrections, not routine successes or secrets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-session-log-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(sessionObservationWorthy({ kind: 'failure', tool: 'bash', outcome: 'failed', summary: 'bash failed: missing module' }), true);
  assert.equal(sessionObservationWorthy({ kind: 'instruction', tool: 'user_input', outcome: 'stated', summary: 'Always use pnpm in this repo, never npm.' }), true);
  assert.equal(sessionObservationWorthy({ kind: 'instruction', tool: 'user_input', outcome: 'stated', summary: 'please list the files' }), false);
  assert.equal(sessionObservationWorthy({ kind: 'failure', tool: 'memory_record', outcome: 'failed', summary: 'memory_record failed: nope' }), false);
  assert.match(clipSessionSummary('token sk-abcdefghijklmnopqrstuvwxyz012345'), /REDACTED/);
  assert.equal(await appendSessionObservation({
    projectId: 'p_test', home, record: {
      id: 'obs_ok', kind: 'instruction', tool: 'user_input', outcome: 'stated',
      summary: 'list files in src', observedAt: '2026-01-01T00:00:00.000Z', provenance: 'declared', sessionId: 's1',
    },
  }), false);
  assert.equal(await appendSessionObservation({
    projectId: 'p_test', home, record: {
      id: 'obs_fail', kind: 'failure', tool: 'bash', outcome: 'failed',
      summary: 'bash failed: gh auth token ghp_abcdefghijklmnopqrstuvwxyz012345',
      observedAt: '2026-01-01T00:00:00.000Z', provenance: 'native_observation', sessionId: 's1',
    },
  }), true);
  const docs = await piSessionSource({ home, scope: { kind: 'project', id: 'p_test' } }).scan();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.kind, 'failure');
  assert.equal(docs[0]?.trust, 'host');
  assert.doesNotMatch(docs[0]?.text ?? '', /ghp_/);
});

test('failed tools and learnable prompts persist for daemon scan without copying bodies', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-session-hooks-'));
  const cwd = join(home, 'work');
  await mkdir(cwd, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const pi = { on(name: string, handler: any) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  installMemoryHooks(pi, { home });
  await handlers.get('session_start')!({}, ctx(cwd));
  await handlers.get('before_agent_start')!(
    { prompt: 'Always use pnpm in this repo, never npm.', systemPrompt: 'Base' }, ctx(cwd));
  await handlers.get('tool_result')!(
    { toolName: 'bash', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'npm ERR! missing script' }] },
    ctx(cwd));
  await handlers.get('tool_result')!(
    { toolName: 'bash', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'ok' }] },
    ctx(cwd));
  const engine = await MemoryEngine.forProject(cwd, 's1', { home, provider: new TestEmbeddingProvider() });
  t.after(() => engine.dispose());
  const root = sessionLogRoot(engine.scopeId, home);
  const files = await (async () => {
    for (const _ of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const names = await readdir(root).catch(() => [] as string[]);
      if (names.some(name => name.endsWith('.jsonl'))) return names;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return readdir(root).catch(() => [] as string[]);
  })();
  assert.ok(files.some(name => name.endsWith('.jsonl')), `expected session jsonl, got ${files.join(',')}`);
  const body = await readFile(join(sessionLogRoot(engine.scopeId, home), files.find(name => name.endsWith('.jsonl'))!), 'utf8');
  assert.match(body, /Always use pnpm/);
  assert.match(body, /npm ERR! missing script/);
  assert.doesNotMatch(body, /"outcome":"succeeded"/);
  const registry = new SourceRegistry();
  await registerKnownSources(registry, engine.scopeId, { home });
  const synced = await registry.sync(async () => engine, 'pi-session');
  assert.ok(synced.queued >= 1);
  assert.equal(engine.projection.stats().documents, 0);
});
