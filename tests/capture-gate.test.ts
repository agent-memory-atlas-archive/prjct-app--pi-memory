import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitCapture } from '../src/retention/capture-gate.ts';

test('capture gate refuses routine noise and exact duplicates but keeps corrections', () => {
  const existing = [{ statement: 'Use SQLite.', kind: 'decision' }];
  assert.equal(admitCapture({ statement: 'ok', kind: 'learning', existing }).accept, false);
  assert.equal(admitCapture({ statement: 'Use SQLite.', kind: 'decision', existing }).reason, 'duplicate');
  assert.equal(admitCapture({ statement: 'Do not use SQLite; Postgres is required.', kind: 'correction', existing }).accept, true);
});
