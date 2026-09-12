import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsSecretShape, redactSecrets } from '../src/security/redact.ts';

test('credential-shaped text is redacted before it can become retained context', () => {
  const raw = 'Authorization: Bearer abcdefghijklmnop and API_TOKEN=super-secret-value';
  const redacted = redactSecrets(raw);
  assert.equal(containsSecretShape(raw), true);
  assert.equal(redacted.includes('abcdefghijklmnop'), false);
  assert.equal(redacted.includes('super-secret-value'), false);
  assert.match(redacted, /<REDACTED>/);
});
