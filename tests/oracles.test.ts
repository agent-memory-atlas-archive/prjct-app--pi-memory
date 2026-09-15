import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreOracle } from '../src/eval/oracles.ts';

test('oracle mechanics score recall, grounding and completeness without a model', () => {
  const hits = [{ statement: 'Use north-alpha-store.', excerpts: ['Decision: use north-alpha-store.'] }];
  const complete = scoreOracle(hits, {
    name: 'complete', query: 'store', kind: 'evidence-complete',
    expectedStatements: ['north-alpha-store'], citations: ['Decision: use north-alpha-store.'],
  });
  assert.equal(complete.passed, true);
  assert.equal(complete.grounded, true);
  const missing = scoreOracle(hits, {
    name: 'missing', query: 'replica', kind: 'final-answer',
    expectedStatements: ['not for replica traffic'],
  });
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.missing, ['not for replica traffic']);
});

test('unanswerable oracle requires explicit empty abstention, never missing forbidden text', () => {
  const kase = { name: 'AWS', query: 'AWS account id?', kind: 'unanswerable' as const, expectedStatements: [] };
  assert.equal(scoreOracle([{ statement: 'SQLite stores project state.' }], kase, { status: 'ok', gaps: [] }).passed, false);
  assert.equal(scoreOracle([], kase).passed, false);
  assert.equal(scoreOracle([], kase, { status: 'abstained', gaps: ['Storage unavailable'] }).passed, false);
  assert.equal(scoreOracle([], kase, { status: 'abstained', gaps: ['Insufficient evidence'] }).passed, true);
});
