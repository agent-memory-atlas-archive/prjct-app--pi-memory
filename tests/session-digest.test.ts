import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digestText, piSessionDigestSource, sessionDigestDocuments } from '../src/sources/session-digest.ts';
import { sessionLogRoot, type SessionObservation } from '../src/sources/session-log.ts';

const scope = { kind: 'project' as const, id: 'p_digest01' };
const observation = (over: Partial<SessionObservation>): SessionObservation => ({
  id: `obs_${Math.random().toString(36).slice(2, 10)}`, kind: 'failure', tool: 'bash', outcome: 'failed',
  summary: 'something happened', observedAt: '2026-09-20T10:00:00.000Z', provenance: 'native_observation',
  sessionId: 's1', ...over,
});

test('a session is one document, not one per observation', () => {
  const rows = [
    observation({ kind: 'correction', tool: 'user', outcome: 'stated', summary: 'Target develop, never main' }),
    observation({ summary: 'error TS2307: Cannot find module ./analytics', observedAt: '2026-09-20T10:05:00.000Z' }),
    observation({ summary: 'vitest: 4 of 16 ChatSessionCache tests failed', observedAt: '2026-09-20T10:09:00.000Z' }),
    observation({ sessionId: 's2', summary: 'docker: network setup failed', observedAt: '2026-09-20T11:00:00.000Z' }),
  ];
  const documents = sessionDigestDocuments(scope, rows, Date.parse('2026-09-20T23:00:00.000Z'), 30 * 60_000);
  // s1 aporta declarado y observado; s2 solo tiene fallos.
  assert.deepEqual(documents.map(d => d.externalId).sort(),
    ['session:s1:declared', 'session:s1:observed', 'session:s2:observed']);

  const declared = documents.find(d => d.externalId === 'session:s1:declared')!;
  assert.equal(declared.trust, 'user', 'lo que dijo el usuario no es una observacion del sistema');
  assert.match(declared.text, /Target develop, never main/);
  assert.doesNotMatch(declared.text, /TS2307/, 'los fallos no se publican como declaraciones del usuario');

  const observed = documents.find(d => d.externalId === 'session:s1:observed')!;
  assert.equal(observed.trust, 'host');
  assert.equal(observed.metadata.failures, '2');
  // El contexto del usuario viaja con los fallos: ahi esta la relacion.
  assert.match(observed.text, /Target develop, never main/);
  assert.match(observed.text, /TS2307/);
  assert.match(observed.text, /ChatSessionCache/);
  assert.doesNotMatch(observed.text, /docker/, 'another session never leaks in');
});

test('what the user said is separated from what broke', () => {
  const text = digestText([
    observation({ kind: 'correction', tool: 'user', outcome: 'stated', summary: 'Use proxy instead of gateway' }),
    observation({ summary: 'ENOENT: no such file or directory' }),
  ]);
  assert.ok(text.indexOf('corrected or instructed') < text.indexOf('failed while working'),
    'instructions come first: they frame everything else');
  assert.match(text, /2 observations/);
});

test('a session still being written is left alone until it settles', () => {
  const live = [observation({ observedAt: '2026-09-20T12:00:00.000Z' })];
  const now = Date.parse('2026-09-20T12:05:00.000Z');
  assert.deepEqual(sessionDigestDocuments(scope, live, now, 30 * 60_000), [],
    're-analysing an open session would pay for the same work on every cycle');
  assert.equal(sessionDigestDocuments(scope, live, now + 40 * 60_000, 30 * 60_000).length, 1);
});

test('the adapter reads the project log and its revision follows the content', async t => {
  const home = await mkdtemp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = sessionLogRoot(scope.id, home);
  await mkdir(root, { recursive: true });
  const rows = [observation({ summary: 'first failure' }), observation({ summary: 'second failure' })];
  await writeFile(join(root, '2026-09-20.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'), 'utf8');

  const adapter = piSessionDigestSource({ home, scope, now: () => Date.parse('2026-09-21T00:00:00.000Z') });
  const before = await adapter.scan();
  assert.equal(before.length, 1, 'solo hay fallos: un unico documento observado');
  assert.equal(before[0]?.trust, 'host');
  assert.equal(before[0]?.metadata.observations, '2');

  await writeFile(join(root, '2026-09-20.jsonl'),
    [...rows, observation({ summary: 'third failure' })].map(row => JSON.stringify(row)).join('\n'), 'utf8');
  const after = await adapter.scan();
  assert.notEqual(after[0]?.version, before[0]?.version, 'a session that grew is analysed again, once');
});

const mkdtemp = async (): Promise<string> => {
  const { mkdtemp: make } = await import('node:fs/promises');
  return make(join(tmpdir(), 'pi-session-digest-'));
};
