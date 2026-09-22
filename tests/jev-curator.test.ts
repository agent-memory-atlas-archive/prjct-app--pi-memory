import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJevCurator, planWithJev, type Ask } from '../src/curation/jev-curator.ts';
import type { Rule } from '../src/curation/curator.ts';

const rule = (id: string, statement: string, recordedAt: string, kind = 'procedure'): Rule => ({ id, kind, statement, recordedAt });

const rules = [
  rule('old-main', 'Merge all completed work to main after develop so QA validates in production.', '2026-01-01T00:00:00Z'),
  rule('new-main', 'Only open a release pull request toward main after develop when the user explicitly asks.', '2026-02-01T00:00:00Z'),
  rule('task', 'Now translate the fifteen landing pages and assign one to each agent.', '2026-01-05T00:00:00Z'),
  rule('ticket-a', 'After merging, label the Linear ticket ready to verify instead of moving it to Done.', '2026-01-02T00:00:00Z'),
  rule('ticket-b', 'After merging a Linear ticket, add the ready to verify label and never move it to Done.', '2026-01-03T00:00:00Z'),
  rule('es', 'En Linear, ready to dev significa listo para desarrollo y ready to verify se agrega después de implementar.', '2026-01-04T00:00:00Z'),
];

// Stands in for Jev: answers keyed by what each question points at.
const scripted = (answers: Record<string, number>): { ask: Ask; seen: { questions: number } } => {
  const seen = { questions: 0 };
  return {
    seen,
    ask: async (state, questions) => {
      const statements = (state as { statements?: Record<string, string> }).statements;
      if (statements) return new Map(Object.keys(questions).map(key => [key, /Always use red/.test(statements[key] ?? '') ? 0.1 : 0.9]));
      seen.questions = Object.keys(questions).length;
      const keys = (state as { rules: Record<string, { statement: string }>; pairs: Record<string, { first: string; second: string }>; messages: Record<string, string> });
      const ruleKey = (text: string) => Object.entries(keys.rules).find(([, value]) => value.statement.startsWith(text))?.[0];
      const resolved = new Map<string, number>();
      for (const [name, value] of Object.entries(answers)) {
        const [target, axis] = name.split(':');
        if (axis === 'junk') resolved.set(`${ruleKey(target!)}_junk`, value);
        if (axis === 'same' || axis === 'conflict') {
          const [a, b] = target!.split('|');
          const pair = Object.entries(keys.pairs).find(([, pr]) => [pr.first, pr.second].some(x => x.startsWith(a!)) && [pr.first, pr.second].some(x => x.startsWith(b!)))?.[0];
          if (pair) resolved.set(`${pair}_${axis}`, value);
        }
        if (axis === 'corrects' || axis === 'general' || axis === 'covered') {
          const message = Object.entries(keys.messages).find(([, text]) => text.startsWith(target!))?.[0];
          if (message) resolved.set(`${message}_${axis}`, value);
        }
      }
      return new Map(Object.keys(questions).map(key => [key, resolved.get(key) ?? 0.05]));
    },
  };
};

const said = [
  'no estamos reutilizando los componentes de heroui ya te lo pedi 3 veces',
  'no uses azul como primario, eso ya lo teniamos definido',
  'hazlo ya',
  'el boton de guardar esta mal alineado en esta pantalla',
];

test('Jev decides retire, fold and conflict without a generative call, and hands only new rules and translations to the writer', async () => {
  const jev = scripted({
    'Now translate:junk': 0.93,
    'Merge all|Only open:conflict': 0.91,
    'After merging, label|After merging a Linear:same': 0.9,
    'no estamos reutilizando:corrects': 0.7, 'no estamos reutilizando:general': 0.65,
    'no uses azul:corrects': 0.66, 'no uses azul:general': 0.6,
    'no uses azul:covered': 0.1,
    'el boton de guardar:corrects': 0.7, 'el boton de guardar:general': 0.2,
  });
  const plan = await planWithJev(rules, said, jev.ask);
  const byId = new Map(plan.actions.map(action => ['id' in action ? action.id : '', action]));
  assert.equal(byId.get('task')?.op, 'retire');
  assert.deepEqual(byId.get('old-main'), { op: 'supersede', id: 'old-main', by: 'new-main', reason: byId.get('old-main')!.reason }, 'the later rule wins a conflict');
  assert.equal((byId.get('ticket-a') as { by?: string } | undefined)?.by, 'ticket-b', 'the more complete wording survives a repeat');
  assert.deepEqual(plan.write.messages.map(message => message.text.slice(0, 20)), ['no estamos reutiliza', 'no uses azul como pr'],
    'only durable, uncovered messages reach the writer');
  assert.deepEqual(plan.write.rules.map(item => item.id), ['es'], 'only the non-English rule is sent for rewriting');
  assert.ok(jev.seen.questions > 0);
});

test('nothing reaches the writer when Jev finds no new rule, and invented quotes are dropped', async () => {
  const quiet = scripted({});
  const calls = { n: 0 };
  const curator = createJevCurator({ provider: 'test', model: 'writer', ask: quiet.ask, write: async request => {
    calls.n += 1;
    assert.deepEqual(request.messages, []);
    return { adds: [], rewrites: [] };
  } });
  await curator.curate(rules.filter(item => item.id !== 'es'), ['hazlo ya'], undefined);
  assert.equal(calls.n, 1, 'the writer is asked, and returns without a model call when the request is empty');

  const loud = scripted({ 'no uses azul:corrects': 0.9, 'no uses azul:general': 0.9 });
  const lying = createJevCurator({ provider: 'test', model: 'writer', ask: loud.ask, write: async request => ({
    adds: [
      { message: request.messages[0]!.id, kind: 'constraint', statement: 'Do not use blue as the primary color.', quote: 'no uses azul como primario' },
      { message: request.messages[0]!.id, kind: 'constraint', statement: 'Always use red.', quote: 'usa rojo siempre' },
      { message: request.messages[0]!.id, kind: 'constraint', statement: 'Always use red on the pricing banner.', quote: 'no uses azul como primario' },
    ],
    rewrites: [],
  }) });
  const actions = await lying.curate([], said, undefined);
  assert.deepEqual(actions.map(action => action.op === 'add' ? action.statement : ''), ['Do not use blue as the primary color.']);
});
