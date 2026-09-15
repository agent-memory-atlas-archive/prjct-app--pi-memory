import { MemoryEngine } from '../src/engine.ts';
import { TestEmbeddingProvider } from './helpers.ts';

const home = process.argv[2];
const projectId = process.argv[3];
if (!home || !projectId) throw new Error('Usage: open-engine-child.mts <home> <projectId>');
const engine = await MemoryEngine.forScope('project', projectId, 'opener', {
  home, provider: new TestEmbeddingProvider(),
});
await engine.dispose();
process.stdout.write('opened-ok\n');
