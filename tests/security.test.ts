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

test('redaction covers common structured secrets without damaging ordinary sk/pk words', () => {
  const join = (...parts: string[]): string => parts.join('');
  const cases = [
    'PASSWORD=hunter2', 'db_password: "value with spaces"', '{"token":"abcdefghijklmnop"}',
    join('ey', 'JhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0In0.', 'signatureabcdefgh'),
    join('-----BEGIN PGP PRIV', 'ATE KEY BLOCK-----\nbody without an end'),
    join('postgres://user:p@', 'ss@db.example/app'), '?access_token=abcdefghijklmnop&x=1',
    'curl -u admin:SuperSecret123 https://example.test',
  ];
  for (const value of cases) assert.notEqual(redactSecrets(value), value, value);
  assert.equal(redactSecrets('skipLibCheck_enabled pkg_manager_version'), 'skipLibCheck_enabled pkg_manager_version');
});

test('adversarial env-key redaction scales without quadratic growth', () => {
  const elapsed = (size: number): number => {
    const input = `A${'KEY'.repeat(size)}`;
    const started = performance.now();
    redactSecrets(input);
    return Math.max(0.01, performance.now() - started);
  };
  const small = elapsed(16_000);
  const large = elapsed(64_000);
  assert.ok(large / small < 12, `redaction scaling ratio ${large / small}`);
});
