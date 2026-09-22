import type { Ask } from '../curation/jev-curator.ts';
import { PROTECTED_TURNS, turnKeyOf, type TurnVerdicts } from './history.ts';
import { groupTurns, turnIsComplete, type HandoffMessage, type Turn } from './turns.ts';

/**
 * Jev decides which old turns the conversation no longer needs.
 *
 * The structural history policy only retires read-only tool rounds; an
 * operator message, a conclusion or an answer stayed in context forever, even
 * after its content became a memory fact. Jev reads each old turn against the
 * latest ones and the project's memory and answers three closed questions.
 * A turn leaves only when nothing still depends on it AND it is either already
 * captured in memory or finished. When unsure, it stays.
 *
 * It runs in the background after a request and never delays one: the verdicts
 * are used from the next context selection on, inside the same batches the
 * history policy already pays for.
 */
export const JUDGE_THRESHOLDS = { needed: 0.4, captured: 0.6, spent: 0.6 } as const;
const MAX_TURNS_PER_ASK = 10;
const MAX_FACTS = 60;

const RUBRIC = {
  needed: 'Later work still depends on this turn: it holds an open question, a decision still in force that no memory fact states, '
    + 'or context the latest turns refer to.',
  captured: 'What this turn established is already stated by one of the memory facts.',
  spent: 'This turn finished its work and nothing after it depends on it: a completed lookup, a done change, a question already answered.',
};

const textOf = (message: HandoffMessage | undefined, limit: number): string => {
  const content = message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.flatMap(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? [String((block as { text?: unknown }).text ?? '')] : []).join(' ') : '';
  return text.replace(/\s+/gu, ' ').trim().slice(0, limit);
};
const toolNames = (turn: Turn): string[] => [...new Set(turn.messages.flatMap(message => Array.isArray(message.content)
  ? message.content.flatMap(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall'
    ? [String((block as { name?: unknown }).name ?? '')] : []) : []))].filter(Boolean).slice(0, 12);
const describe = (turn: Turn) => ({
  request: textOf(turn.messages[0], 600),
  answer: textOf([...turn.messages].reverse().find(message => message.role === 'assistant' && textOf(message, 1)), 800),
  tools: toolNames(turn),
});

export type TurnJudge = Readonly<{
  /** Retirable turns for a session, as known now. */
  verdicts(session: string): TurnVerdicts;
  /** Judge the old turns not judged yet. Never throws; at most one run per session at a time. */
  consider(session: string, messages: readonly HandoffMessage[]): Promise<void>;
}>;

export const createTurnJudge = (deps: Readonly<{
  ask: () => Promise<Ask | undefined>;
  facts: () => Promise<readonly string[]>;
}>): TurnJudge => {
  type Slot = { retire: Map<string, { reason: string }>; seen: Set<string>; running?: Promise<void> };
  const sessions = new Map<string, Slot>();
  const slot = (session: string): Slot => {
    const found = sessions.get(session);
    if (found) return found;
    const created: Slot = { retire: new Map(), seen: new Set() };
    sessions.set(session, created);
    return created;
  };
  const run = async (session: string, messages: readonly HandoffMessage[]): Promise<void> => {
    const state = slot(session);
    const turns = groupTurns(messages);
    const old = turns.slice(0, Math.max(0, turns.length - 1 - PROTECTED_TURNS))
      .filter(turn => turn.messages[0]?.role === 'user' && turnIsComplete(turn) && !state.seen.has(turnKeyOf(turn)))
      .slice(0, MAX_TURNS_PER_ASK);
    if (!old.length) return;
    const ask = await deps.ask().catch(() => undefined);
    if (!ask) return;
    const recent = turns.slice(-1 - PROTECTED_TURNS).map(turn => textOf(turn.messages[0], 400)).filter(Boolean);
    const facts = (await deps.facts().catch(() => [] as readonly string[])).slice(0, MAX_FACTS).map(fact => fact.slice(0, 300));
    const shown = old.map((turn, index) => ({ key: `t${index}`, id: turnKeyOf(turn), turn }));
    const questions = Object.fromEntries(shown.flatMap(({ key }) => [
      [`${key}_needed`, `Turn ${key}: ${RUBRIC.needed}`],
      [`${key}_captured`, `Turn ${key}: ${RUBRIC.captured}`],
      [`${key}_spent`, `Turn ${key}: ${RUBRIC.spent}`],
    ]));
    const answers = await ask({ latest_turns: recent, memory_facts: facts,
      turns: Object.fromEntries(shown.map(({ key, turn }) => [key, describe(turn)])) }, questions).catch(() => undefined);
    if (!answers) return;
    for (const { key, id } of shown) {
      state.seen.add(id);
      const needed = answers.get(`${key}_needed`) ?? 1;
      const captured = answers.get(`${key}_captured`) ?? 0;
      const spent = answers.get(`${key}_spent`) ?? 0;
      if (needed >= JUDGE_THRESHOLDS.needed) continue;
      if (captured >= JUDGE_THRESHOLDS.captured) state.retire.set(id, { reason: 'captured in memory' });
      else if (spent >= JUDGE_THRESHOLDS.spent) state.retire.set(id, { reason: 'finished; nothing later depends on it' });
    }
  };
  return {
    verdicts: session => slot(session).retire,
    consider: (session, messages) => {
      const state = slot(session);
      if (state.running) return state.running;
      const running = run(session, messages).catch(() => undefined).finally(() => { state.running = undefined; });
      state.running = running;
      return running;
    },
  };
};
