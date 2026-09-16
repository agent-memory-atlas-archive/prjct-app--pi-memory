import { MemoryEngine } from '../src/engine.ts';
import { TestEmbeddingProvider } from './helpers.ts';
const [root, mode] = process.argv.slice(2);
const engine = new MemoryEngine({ root: root!, scopeId: 'p_wal', sessionId: mode!, provider: new TestEmbeddingProvider() });
const pause = () => {
  process.stdout.write('READY\n');
  setInterval(() => undefined, 1000);
};
if (mode === 'reader') {
  engine.projection.db.exec('BEGIN');
  engine.projection.db.prepare('SELECT COUNT(*) FROM facts').get();
  pause();
} else if (mode === 'writer') {
  engine.projection.db.exec('BEGIN IMMEDIATE');
  pause();
} else {
  const facts = ['Alpha authority', 'Beta authority'].map(statement => engine.composeFact({
    kind: 'fact', statement, confidence: 1, standing: 'supported', evidence: [], entities: [], episodeIds: [], tags: {},
  }));
  engine.authorityTransaction(() => {
    for (const fact of facts) engine.commitAuthority({ type: 'fact.recorded', fact });
    if (mode === 'pre-commit') {
      process.stdout.write('READY\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  });
  if (mode === 'post-checkpoint') engine.projection.checkpointWal();
  pause();
}
