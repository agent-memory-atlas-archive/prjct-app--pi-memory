import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorModel, formatPanel, memoryPanel, presentMemoryPanel, resultModel, sourcesModel, statusModel, syncModel,
} from '../src/extension/panel.ts';

const stats = { documents: 0, chunks: 0, vectors: 0, facts: 3, events: 1, bytes: 2048 };
const curation = {
  fingerprints: 2, pending: 1, claimed: 0, failed: 1, blocked: 0, published: 4,
  spend: { day: '2026-09-16', calls: 1, inputTokens: 10, outputTokens: 4, embeddingCalls: 0 },
};

test('status panel fits 80 and 40 columns and keeps labels', () => {
  const model = statusModel({ scope: 'project/p_demo', stats, curation, error: 'sync failed' });
  for (const width of [80, 40, 16]) {
    const lines = formatPanel(model, width);
    assert.ok(lines.length <= 22);
    const cells = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(lines.every(line => cells(line).length <= width + 3), `wide line at ${width}: ${JSON.stringify(lines.find(line => cells(line).length > width + 3))}`);
    assert.ok(lines.some(line => line.includes('facts')));
    assert.ok(lines.some(line => line.includes('error')));
    assert.ok(lines.some(line => /esc\/enter close/.test(line)));
  }
});

test('sources panel is one row per adapter, not nested JSON', () => {
  const lines = formatPanel(sourcesModel({
    scope: 'project/p_demo',
    adapters: [
      { adapter: 'pi-session', due: true, reason: '8 turns' },
      { adapter: 'prjct-observations', due: false, reason: 'synced 120s ago, minimum is 300s' },
    ],
  }), 80).join('\n');
  assert.match(lines, /pi-session\s+yes/);
  assert.match(lines, /prjct-observations\s+no/);
  assert.doesNotMatch(lines, /"fingerprints"/);
  assert.doesNotMatch(lines, /\{/);
});

test('untrusted error text cannot inject escapes', () => {
  const lines = formatPanel(errorModel('oops \u001b[31mHACK\u001b[0m'), 80);
  assert.ok(lines.every(line => !line.includes('\u001b[31m')));
});

test('sync panel states the outcome instead of dumping adapter JSON', () => {
  const lines = formatPanel(syncModel([{
    adapter: 'pi-session', scope: { kind: 'project', id: 'p_demo' }, discovered: 3, indexed: 0,
    unchanged: 3, dense: 0, removed: 0, queued: 0, gaps: [],
  }]), 80).join('\n');
  assert.match(lines, /no new fingerprints/);
  assert.match(lines, /pi-session\s+3 seen\s+3 same\s+idle/);
  assert.doesNotMatch(lines, /"discovered"/);
  assert.doesNotMatch(lines, /"unchanged"/);
});

test('sync panel bounds gaps to a cell', () => {
  const lines = formatPanel(syncModel([{
    adapter: 'pi-session', scope: { kind: 'project', id: 'p_demo' }, discovered: 2, indexed: 1,
    unchanged: 1, dense: 0, removed: 0, queued: 1, gaps: ['long gap '.repeat(40)],
  }]), 40);
  const cells = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(lines.every(line => cells(line).length <= 43), JSON.stringify(lines.map(cells)));
});

test('panel closes on escape and enter', () => {
  const closed = { n: 0 };
  const panel = memoryPanel(statusModel({ scope: 'project/p_x', stats, curation }), {
    fg: (_slot: string, text: string) => text,
    bold: (text: string) => text,
  } as never, () => { closed.n += 1; });
  panel.handleInput?.('\x1b');
  panel.handleInput?.('\r');
  assert.equal(closed.n, 2);
});

test('presentMemoryPanel falls back to notify without hasUI', async () => {
  const seen: string[] = [];
  await presentMemoryPanel({
    ui: { notify(message) { seen.push(message); } },
  }, statusModel({ scope: 'project/p_x', stats, curation }));
  assert.match(seen[0] ?? '', /facts 3/);
  assert.doesNotMatch(seen[0] ?? '', /"documents"/);
});

test('RPC mode uses notify even though the host reports UI support', async () => {
  const seen: string[] = [];
  const custom = { calls: 0 };
  await presentMemoryPanel({ mode: 'rpc', hasUI: true, ui: {
    notify(message) { seen.push(message); },
    async custom<T>() { custom.calls += 1; return undefined as T; },
  } }, statusModel({ scope: 'project/p_x', stats, curation }));
  assert.equal(custom.calls, 0);
  assert.match(seen[0] ?? '', /memory · status/u);
});

test('init, sources and error use the same framed card as sync', () => {
  const init = formatPanel(resultModel('memory · init', [
    'status initialized', 'project p_demo', 'checkout abc', 'source git', 'location /tmp/demo',
  ]), 72).join('\n');
  const sources = formatPanel(sourcesModel({
    scope: 'project/p_demo',
    adapters: [{ adapter: 'pi-session', due: true, reason: '8 turns' }],
  }), 72).join('\n');
  const error = formatPanel(errorModel('disk full'), 72).join('\n');
  const sync = formatPanel(syncModel([{
    adapter: 'pi-session', scope: { kind: 'project', id: 'p_demo' }, discovered: 3, indexed: 0,
    unchanged: 3, dense: 0, removed: 0, queued: 0, gaps: [],
  }]), 72).join('\n');
  for (const panel of [init, sources, error, sync]) {
    assert.match(panel, /╭─ memory ·/);
    assert.match(panel, /╰─+/);
    assert.match(panel, /esc\/enter close/);
    assert.doesNotMatch(panel, /"adapter"/);
  }
  assert.match(init, /status initialized/);
  assert.match(sources, /due 1/);
  assert.match(error, /status error/);
});

test('dismissed overlay falls back to the same panel text, not JSON or abort', async () => {
  const seen: string[] = [];
  const error = Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
  await presentMemoryPanel({ mode: 'tui', hasUI: true, ui: {
    notify(message) { seen.push(message); },
    async custom<T>() { throw error; return undefined as T; },
  } }, syncModel([{
    adapter: 'pi-session', scope: { kind: 'project', id: 'p_demo' }, discovered: 3, indexed: 0,
    unchanged: 3, dense: 0, removed: 0, queued: 0, gaps: [],
  }]));
  assert.match(seen[0] ?? '', /no new fingerprints/);
  assert.doesNotMatch(seen[0] ?? '', /"adapter"/);
  assert.doesNotMatch(seen[0] ?? '', /Operation aborted/);
});
