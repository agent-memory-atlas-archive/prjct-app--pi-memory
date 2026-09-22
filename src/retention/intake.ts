import type { Ask } from '../curation/jev-curator.ts';
import { RAW_FAILURE } from './maintenance.ts';

/**
 * What an automatic capture may store. Nothing is written first and cleaned up
 * later: a statement that is only the state of one run never enters memory.
 *
 * Raw tool output ("bash: ...", ENOENT, a path that was not there) is refused
 * outright. Everything else auto-derived is put to Jev in one request, one
 * question per statement; only what it calls a durable lesson with enough
 * confidence is kept. When Jev cannot answer, nothing auto-derived is kept:
 * the session log still has it, and memory stays clean.
 */
export const DURABLE_THRESHOLD = 0.6;

const RUBRIC = 'A durable lesson names a cause, a fix, a constraint or a procedure that would still help a later, different task '
  + 'in this project. The momentary state of one run is not durable: a test count, one failing test, a file missing at one moment, '
  + 'a command that failed once, a stack trace, or output pasted without a lesson.';

export type IntakeVerdict = Readonly<{ keep: boolean; reason: string; confidence?: number }>;

export const judgeAutoCaptures = async (statements: readonly string[], ask: Ask | undefined,
  signal?: AbortSignal): Promise<IntakeVerdict[]> => {
  const verdicts: (IntakeVerdict | undefined)[] = statements.map(statement =>
    RAW_FAILURE.test(statement) ? { keep: false, reason: 'raw tool output' } : undefined);
  const open = statements.flatMap((statement, index) => verdicts[index] ? [] : [{ key: `s${index}`, index, statement }]);
  if (!open.length) return verdicts as IntakeVerdict[];
  if (!ask) {
    for (const item of open) verdicts[item.index] = { keep: false, reason: 'no Jev to judge it' };
    return verdicts as IntakeVerdict[];
  }
  const answers = await ask(
    { rubric: RUBRIC, statements: Object.fromEntries(open.map(item => [item.key, item.statement.slice(0, 1_500)])) },
    Object.fromEntries(open.map(item => [`${item.key}_durable`, `Statement ${item.key} is a durable lesson (see rubric), not the state of one run.`])),
    signal,
  ).catch(() => undefined);
  for (const item of open) {
    const confidence = answers?.get(`${item.key}_durable`);
    verdicts[item.index] = confidence === undefined
      ? { keep: false, reason: 'Jev unavailable' }
      : confidence >= DURABLE_THRESHOLD
        ? { keep: true, reason: 'durable lesson', confidence }
        : { keep: false, reason: 'state of one run', confidence };
  }
  return verdicts as IntakeVerdict[];
};
