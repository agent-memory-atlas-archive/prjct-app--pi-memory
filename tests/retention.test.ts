import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessValue } from '../src/retention/value.ts';
import { consolidationCandidates } from '../src/retention/consolidation.ts';
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
