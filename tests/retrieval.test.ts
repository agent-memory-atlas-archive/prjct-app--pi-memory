import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../src/engine.ts';
import { sha256 } from '../src/workspace/project-identity.ts';
import { retrievalMetrics } from './eval/metrics.ts';
import { TestEmbeddingProvider } from './helpers.ts';

test('hybrid retrieval beats lexical-only on cross-vocabulary cases without losing exact hits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-retrieval-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const docs = [
    ['db', 'SQLite is the durable project storage'],
    ['auth', 'OAuth refresh can fail during concurrent login'],
    ['ui', 'The frontend button uses strong contrast'],
  ];
  for (const [id, text] of docs) await engine.index({ namespace: 'test', externalId: id!, scopeId: 'p_test', scopeKind: 'project',
    source: 'fixture', kind: 'fact', text: text!, version: sha256(text!), contentHash: sha256(text!),
    observedAt: new Date().toISOString(), trust: 'host', metadata: {} });
  const queries = [['database persistence', 'db'], ['authentication renewal error', 'auth'], ['frontend button', 'ui']] as const;
  const lexical = queries.map(([query]) => engine.projection.lexicalSearch(query, 10).map(hit => engine.projection.chunks([hit.chunkId])[0]!.document.externalId));
  const hybrid = [] as string[][];
  for (const [query] of queries) hybrid.push((await engine.search({ queries: [query], dense: true, limit: 3 })).items.map(item => item.id));
  const truth = queries.map(([, id]) => new Set([id]));
  const baseline = retrievalMetrics(lexical, truth, 3);
  const candidate = retrievalMetrics(hybrid, truth, 3);
  assert.ok(candidate.ndcgAtK > baseline.ndcgAtK);
  assert.equal(candidate.recallAtK, 1);
});
