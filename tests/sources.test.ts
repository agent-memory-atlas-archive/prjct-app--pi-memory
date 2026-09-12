import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PrjctObservationAdapter } from '../src/sources/prjct.ts';
import { TeamJournalAdapter } from '../src/sources/team.ts';

test('prjct adapter converts attributable observation journals without importing prjct', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-memory-source-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, 'p_test', 'prjct', 'work', 'sessions', '20260101', 'session_123');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'writer.json'), JSON.stringify({ payload: { observations: [{ id: 'obs_1', provenance: 'native_observation',
    summary: 'authentication test failed', recordedAt: '2026-01-01T00:00:00.000Z', execution: { toolName: 'bash', outcome: 'failed', sourcePaths: ['src/auth.ts'] } }] } }));
  const docs = await new PrjctObservationAdapter(home, 'p_test').scan();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.kind, 'failure');
  assert.equal(docs[0]?.trust, 'host');
});

test('team adapter indexes settled threads and content-addressed artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mailbox = join(root, 'agent-teams');
  const journal = join(mailbox, 'demo', 'journal');
  await mkdir(journal, { recursive: true });
  await writeFile(join(journal, '2026-01-01.jsonl'), `${JSON.stringify({ type: 'thread', at: Date.parse('2026-01-01'), rootId: 'r1', subject: 'Login', requested: 'Fix auth', delivered: 'Fixed OAuth', outcome: 'completed' })}\n`);
  const artifacts = join(root, 'teams', 't_demo', 'team', 'artifacts');
  await mkdir(join(artifacts, 'index'), { recursive: true });
  await mkdir(join(artifacts, 'blobs'), { recursive: true });
  const sha = 'a'.repeat(64);
  await writeFile(join(artifacts, 'index', '2026-01-01.jsonl'), `${JSON.stringify({ artifactId: 'a1', sha, at: Date.parse('2026-01-01'), path: '/repo/src/auth.ts', name: 'auth.ts', stored: true, bytes: 12 })}\n`);
  await writeFile(join(artifacts, 'blobs', sha), 'export const auth = true');
  const docs = await new TeamJournalAdapter({ mailboxRoot: mailbox, teamName: 'demo', teamId: 't_demo', prjctHome: root }).scan();
  assert.deepEqual(docs.map(doc => doc.namespace).sort(), ['pi-team.artifact', 'pi-team.journal']);
});
