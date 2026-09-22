import { MemoryEngine } from '../src/engine.ts';
for (const repo of process.argv.slice(2)) {
  const e = await MemoryEngine.forInitializedProject(repo, 'inspect');
  const all = e.projection.activeFacts(e.scopeId, 500);
  console.log(`\n== ${repo.split('/').at(-1)}: ${all.filter(f => f.kind !== 'failure').length} rules, ${all.filter(f => f.kind === 'failure').length} failures`);
  for (const f of all.filter(f => f.kind !== 'failure')) console.log(' ', f.kind.slice(0, 5), '|', f.statement.replace(/\s+/g, ' ').slice(0, 125));
  await e.dispose();
}
