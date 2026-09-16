import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentKey, parseDocumentKey } from '../src/contracts/documents.ts';

test('document keys survive SQLite text bindings and round-trip arbitrary source ids', () => {
  const first = { namespace: 'memory', externalId: 'one/二:three' };
  const second = { namespace: 'memory', externalId: 'different' };
  const key = documentKey(first);
  assert.ok(!key.includes('\u0000'));
  assert.notEqual(key, documentKey(second));
  assert.deepEqual(parseDocumentKey(key), first);
});
