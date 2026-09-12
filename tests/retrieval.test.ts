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

// Source diversity capped every result set at ceil(limit/3) even when every
// document came from the same source, which is the normal case for a project
// scope. Ten matching documents from one source must still fill a limit of ten.
test('a single-source scope is not truncated by the source diversity cap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-diversity-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const topics = ['sqlite', 'oauth', 'cache', 'deploy', 'search', 'memory', 'team', 'schema', 'vector', 'release'];
  for (const topic of topics) {
    const text = `The ${topic} decision was recorded for later retrieval.`;
    await engine.index({ namespace: 'test', externalId: topic, scopeId: 'p_test', scopeKind: 'project',
      source: 'fixture', kind: 'fact', text, version: sha256(text), contentHash: sha256(text),
      observedAt: new Date().toISOString(), trust: 'host', metadata: {} });
  }
  const found = await engine.search({ queries: ['decision recorded retrieval'], dense: false, limit: 10, maxBytes: 32_768 });
  assert.equal(new Set(found.items.map(item => item.source)).size, 1);
  assert.equal(found.items.length, 10);

  // Matching more documents than the limit is ordinary, not a degraded answer:
  // it is reported through `omitted`, and the status stays 'ok'.
  const narrow = await engine.search({ queries: ['decision recorded retrieval'], dense: false, limit: 3, maxBytes: 32_768 });
  assert.equal(narrow.items.length, 3);
  assert.ok(narrow.omitted > 0);
  assert.equal(narrow.status, 'ok');
  assert.deepEqual(narrow.gaps, []);

  // A byte budget that truncates the answer IS degradation.
  const squeezed = await engine.search({ queries: ['decision recorded retrieval'], dense: false, limit: 10, maxBytes: 512 });
  assert.equal(squeezed.status, 'partial');
});

test('score thresholds filter automatic candidates without hiding ordinary lookup results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-threshold-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  await engine.index({ namespace: 'test', externalId: 'db', scopeId: 'p_test', scopeKind: 'project',
    source: 'fixture', kind: 'fact', text: 'SQLite is durable project storage', version: 'v1', contentHash: sha256('storage'),
    observedAt: new Date().toISOString(), trust: 'host', metadata: {} });
  assert.equal((await engine.search({ queries: ['storage'], dense: true })).items.length, 1);
  assert.equal((await engine.search({ queries: ['storage'], dense: true, scoreThreshold: 0.9 })).items.length, 0);
});

// A prose prompt tokenizes to many terms, most of them near-ubiquitous. BM25
// already down-weights common terms, so the RANKING barely moves — what changes
// is how much of the corpus FTS5 has to score. The contract worth pinning is
// therefore the selection itself: rare terms kept, ubiquitous ones dropped.
test('lexical search keeps the rare terms of a long prose query and drops ubiquitous ones', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-selective-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_test', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  const filler = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa';
  for (const index of Array.from({ length: 40 }, (_, value) => value)) {
    const text = `${filler} quebec romeo sierra tango uniform victor whiskey xray record ${index}.`;
    await engine.index({ namespace: 'test', externalId: `common-${index}`, scopeId: 'p_test', scopeKind: 'project',
      source: 'fixture', kind: 'fact', text, version: sha256(text), contentHash: sha256(text),
      observedAt: new Date().toISOString(), trust: 'host', metadata: {} });
  }
  const rare = 'zygomorphic quantisation';
  const needle = `${filler} ${rare}.`;
  await engine.index({ namespace: 'test', externalId: 'needle', scopeId: 'p_test', scopeKind: 'project',
    source: 'fixture', kind: 'fact', text: needle, version: sha256(needle), contentHash: sha256(needle),
    observedAt: new Date().toISOString(), trust: 'host', metadata: {} });

  const prompt = `${filler} quebec romeo sierra tango uniform victor whiskey xray ${rare}`;
  const tokens = prompt.split(' ');
  const chosen = engine.projection.selectiveTerms(tokens);
  assert.equal(chosen.length, 12, 'selection is capped');
  assert.ok(chosen.length < new Set(tokens).size, 'the query really did have more terms than the cap');
  // Selection is strictly by document frequency: the 2 terms in 1 document and
  // the 8 in 40 of 41 are all more selective than any filler term, which is in
  // every document, so all ten must be chosen ahead of any filler.
  const rareTerms = ['zygomorphic', 'quantisation'];
  const midTerms = ['quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray'];
  for (const term of [...rareTerms, ...midTerms]) assert.ok(chosen.includes(term), `kept ${term}`);
  const fillerKept = chosen.filter(term => filler.split(' ').includes(term));
  assert.equal(fillerKept.length, 2, 'only the leftover slots go to ubiquitous terms');
  // And the answer is still found.
  const hits = engine.projection.lexicalSearch(prompt, 10);
  assert.equal(engine.projection.chunks([hits[0]!.chunkId])[0]!.document.externalId, 'needle');
});
