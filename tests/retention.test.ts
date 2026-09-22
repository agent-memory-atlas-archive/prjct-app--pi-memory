import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessValue } from '../src/retention/value.ts';
import { consolidationCandidates, semanticConsolidationCandidates } from '../src/retention/consolidation.ts';
import type { StoredFact } from '../src/storage/projection.ts';

const fact = (over: Partial<StoredFact> = {}): StoredFact => ({
  id: 'mem_12345678', scopeId: 'p_test', kind: 'decision', statement: 'Use SQLite as the durable project storage',
  entities: [], evidence: [], episodeIds: [], standing: 'supported', confidence: 0.8,
  recordedAt: '2026-01-01T00:00:00.000Z', tags: {}, usefulness: 0, ...over,
});

test('value protects supported judgment instead of equating novelty with value', () => {
  const assessment = assessValue(fact({ evidence: [{ id: 'ev_12345678', origin: 'user_statement', provenance: 'declared',
    contentHash: '0'.repeat(64), excerpt: 'Use SQLite', observedAt: '2026-01-01T00:00:00.000Z' }] }), Date.parse('2026-02-01T00:00:00.000Z'));
  assert.equal(assessment.protected, true);
  assert.ok(assessment.score >= 70);
});

test('consolidation only proposes duplicate and contradiction candidates', () => {
  const duplicate = fact({ id: 'mem_abcdefgh', statement: 'Use SQLite for durable project storage', recordedAt: '2026-02-01T00:00:00.000Z' });
  const unrelated = fact({ id: 'mem_unrelated', statement: 'Render buttons with high contrast' });
  const candidates = consolidationCandidates([fact(), duplicate, unrelated], 0.6);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.canonicalId, duplicate.id);
  assert.equal(candidates[0]?.action, 'review-duplicate');
});

/** Two statements of the same rule in different languages: the word-overlap
 * comparison sees nothing, so only the encoder can pair them. Vectors are
 * stubbed to keep the test hermetic; the real encoder is the multilingual one
 * dense search already loads. */
const stubEmbedder = (map: Record<string, number[]>) =>
  async (texts: readonly string[]): Promise<number[][]> => texts.map(text => map[text] ?? [0, 0, 1]);

test('semantic consolidation pairs the same rule written in two languages', async () => {
  // Tomadas de una memoria real: la misma regla capturada cuatro veces en tres idiomas.
  const spanish = fact({ id: 'mem_spanish0', kind: 'procedure',
    statement: 'mueve el ticket y agrega el comentario de la implementacion, lo debes poner como ready to verify y no a done' });
  const english = fact({ id: 'mem_english0', kind: 'procedure', recordedAt: '2026-03-01T00:00:00.000Z',
    statement: 'After implementing and merging work associated with a Linear ticket, do not move it to Done. Add the ready to verify label so QA can review it, and post a comment with the implementation details.' });
  const unrelated = fact({ id: 'mem_unrelate', statement: 'Render buttons with high contrast' });

  // Lexical alone cannot see it: they share no words above the length floor.
  assert.equal(consolidationCandidates([spanish, english, unrelated]).length, 0);

  const candidates = await semanticConsolidationCandidates([spanish, english, unrelated], {
    embed: stubEmbedder({ [spanish.statement]: [1, 0, 0], [english.statement]: [0.97, 0.24, 0] }),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.canonicalId, english.id, 'the newest statement is the canonical one');
  assert.deepEqual(candidates[0]?.relatedIds, [spanish.id]);
  assert.equal(candidates[0]?.action, 'review-duplicate');
});

test('semantic consolidation keeps unrelated facts apart and survives a dead encoder', async () => {
  const a = fact({ id: 'mem_aaaaaaaa', statement: 'Use SQLite as the durable project storage' });
  const b = fact({ id: 'mem_bbbbbbbb', statement: 'Render buttons with high contrast' });
  const apart = await semanticConsolidationCandidates([a, b], {
    embed: stubEmbedder({ [a.statement]: [1, 0, 0], [b.statement]: [0, 1, 0] }),
  });
  assert.deepEqual(apart, []);

  // A missing model must degrade to the lexical answer, never take the pass down.
  const duplicate = fact({ id: 'mem_dupdupdu', statement: 'Use SQLite for durable project storage', recordedAt: '2026-02-01T00:00:00.000Z' });
  const fallback = await semanticConsolidationCandidates([a, duplicate], {
    embed: async () => { throw new Error('no encoder'); }, lexicalThreshold: 0.6,
  });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.canonicalId, duplicate.id);
});
