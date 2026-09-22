import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ask } from '../curation/jev-curator.ts';
import type { MemoryEngine } from '../engine.ts';
import { judgeAutoCaptures } from './intake.ts';

/**
 * One pass over what is already stored, for memory written before deleting
 * meant deleting: every fact left superseded or contradicted, and every live
 * `failure` that Jev calls the state of one run rather than a lesson. Planning
 * reads only; running backs the store up first, then purges.
 */
export type SweepPlan = Readonly<{
  dead: readonly string[];
  junk: readonly Readonly<{ id: string; statement: string; reason: string }>[];
  judged: boolean;
}>;

export const planSweep = async (engine: MemoryEngine, ask: Ask | undefined, signal?: AbortSignal): Promise<SweepPlan> => {
  const dead = engine.projection.deadFactIds(engine.scopeId);
  const failures = engine.projection.activeFacts(engine.scopeId, 1_000).filter(fact => fact.kind === 'failure');
  if (!failures.length) return { dead, junk: [], judged: Boolean(ask) };
  // Without Jev only raw tool output is certain garbage; a failure that reads like a lesson is left for Jev.
  const verdicts = await judgeAutoCaptures(failures.map(fact => fact.statement), ask, signal);
  const junk = failures.flatMap((fact, index) => {
    const verdict = verdicts[index]!;
    if (verdict.keep) return [];
    if (!ask && verdict.reason !== 'raw tool output') return [];
    return [{ id: fact.id, statement: fact.statement, reason: verdict.reason }];
  });
  return { dead, junk, judged: Boolean(ask) };
};

export const runSweep = async (engine: MemoryEngine, plan: SweepPlan, backupRoot: string) => {
  const ids = [...plan.dead, ...plan.junk.map(item => item.id)];
  if (!ids.length) return { backup: undefined, facts: 0, documents: 0, evidence: 0, events: 0, deferred: 0 };
  const backup = join(backupRoot, engine.scopeId);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  engine.projection.exportSnapshot(join(backup, 'memory.sqlite'));
  await cp(join(engine.root, 'events'), join(backup, 'events'), { recursive: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  return { backup, ...await engine.purgeFacts(ids) };
};
