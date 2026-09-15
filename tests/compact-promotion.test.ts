import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompactJournal } from '../src/storage/compact-journal.ts';
import { CompactStore } from '../src/storage/compact-store.ts';
import { MemoryJournal } from '../src/storage/journal.ts';
import { promoteCompactAuthority } from '../src/storage/promotion.ts';
import { sha256 } from '../src/workspace/project-identity.ts';

const SCOPE = 'p_promotion';

test('failed promotion rolls back domain population and mode; retry switches authority last', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compact-promotion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'memory.sqlite');
  const compact = new CompactStore(path, SCOPE);
  const journal = new CompactJournal(compact, SCOPE, 'session');
  const text = 'Atomic promotion keeps the compact authority readable until mode switch.';
  const original = await journal.append({ type: 'document.upserted', document: {
    namespace: 'docs', externalId: 'promotion', scopeId: SCOPE, scopeKind: 'project', source: 'test', kind: 'decision',
    title: 'Promotion', text, version: 'v1', contentHash: sha256(text), observedAt: '2026-01-01T00:00:00.000Z',
    trust: 'host', metadata: {},
  } });
  compact.curation.enqueue({ id: 'job_keep', scopeId: SCOPE, adapter: 'docs', documentKey: 'docs\u0000promotion',
    action: 'review', inputRevision: 'v1', contentHash: sha256(text) });
  const blocker = new DatabaseSync(path);
  blocker.exec(`CREATE TRIGGER stop_mode BEFORE UPDATE OF mode ON compact_authority
    WHEN NEW.mode=1 BEGIN SELECT RAISE(ABORT, 'stop promotion'); END`);
  blocker.close();

  assert.throws(() => promoteCompactAuthority(root, path, SCOPE, compact), /stop promotion/);
  assert.equal(compact.mode(), 0);
  assert.equal(compact.projection.documentByKey({ namespace: 'docs', externalId: 'promotion' })?.text, text);
  assert.equal(compact.curation.getJob('job_keep')?.status, 'pending');
  const staged = new DatabaseSync(path);
  assert.equal((staged.prepare('SELECT mode FROM compact_authority').get() as { mode: number }).mode, 0);
  assert.equal((staged.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n, 0, 'failed population leaked rows');
  staged.exec('DROP TRIGGER stop_mode');
  staged.close();

  const concurrent = new CompactStore(path, SCOPE);
  const lateJournal = new CompactJournal(concurrent, SCOPE, 'late-session');
  const lock = compact.withPromotionLock.bind(compact);
  compact.withPromotionLock = action => {
    lateJournal.appendAuthority({ type: 'document.upserted', document: {
      namespace: 'docs', externalId: 'late', scopeId: SCOPE, scopeKind: 'project', source: 'test', kind: 'decision',
      title: 'Late', text: 'Committed after staging.', version: 'v1', contentHash: sha256('Committed after staging.'),
      observedAt: '2026-01-02T00:00:00.000Z', trust: 'host', metadata: {},
    } });
    return lock(action);
  };
  const indexed = promoteCompactAuthority(root, path, SCOPE, compact);
  concurrent.close();
  compact.close();
  assert.equal((indexed.db.prepare('SELECT mode FROM compact_authority').get() as { mode: number }).mode, 1);
  assert.equal(indexed.documentByKey({ namespace: 'docs', externalId: 'promotion' })?.text, text);
  assert.equal(indexed.documentByKey({ namespace: 'docs', externalId: 'late' })?.text, 'Committed after staging.');
  const curation = indexed.attachCuration(path);
  assert.equal(curation.getJob('job_keep')?.status, 'pending');
  const recovered = await new MemoryJournal(root, SCOPE, 'reader').readAll();
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0]?.eventHash, original.eventHash);
  curation.close();
  indexed.close();
});
