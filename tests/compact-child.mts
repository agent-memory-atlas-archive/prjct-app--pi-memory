import { DatabaseSync } from 'node:sqlite';
import { CompactAuthority } from '../src/storage/compact-authority.ts';
const [path, mode] = process.argv.slice(2);
if (mode === 'pre-commit') {
  const db = new DatabaseSync(path!);
  db.exec('BEGIN IMMEDIATE; UPDATE compact_authority SET revision=999');
  process.stdout.write('READY\n');
  setInterval(() => undefined, 1000);
} else {
  const store = new CompactAuthority(path!, 'p_test');
  if (mode?.startsWith('race-')) {
    const revision = store.read().revision;
    process.stdin.once('data', () => {
      const result = store.compareAndSwap(revision, { writer: mode });
      process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
      store.close(); process.stdin.destroy();
    });
    process.stdout.write('READY\n');
  } else {
    const result = store.compareAndSwap(0, { facts: ['Alpha', 'Beta'], history: ['both committed'] });
    if (result.status !== 'committed') throw new Error('Unexpected blocked child publication');
    if (mode === 'post-checkpoint') store.checkpoint();
    process.stdout.write('READY\n');
    setInterval(() => undefined, 1000);
  }
}
