import { initializeMemoryProjectWith } from '../src/workspace/memory-registry.ts';

const [checkout, home] = process.argv.slice(2);
if (!checkout || !home) throw new Error('checkout and home are required');
await initializeMemoryProjectWith(checkout, home, async () => {
  process.stdout.write('locked\n');
  await new Promise<never>(() => undefined);
});
