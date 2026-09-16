import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { MemoryEngine } from '../engine.ts';
import { DEFAULT_HANDOFF_BUDGET, estimateHandoffTokens, selectHandoffMessages, type HandoffBudget } from './select.ts';
import { assertCheckpoint, readCheckpoint, writeCheckpoint, type OperationalCheckpoint } from './checkpoint.ts';
import type { HandoffMessage } from './turns.ts';

export type HandoffState = Readonly<{
  projectId: string;
  workspace: string;
  sessionId: string;
  active: boolean;
  notice?: string;
}>;

type HandoffGate = Readonly<{
  workspace: string;
  sessionId: string;
  projectId?: string;
  failure?: string;
}>;

const keyOf = (projectId: string, sessionId: string): string => `${projectId}\u0000${sessionId}`;
const gateKeyOf = (workspace: string, sessionId: string): string => `${workspace}\u0000${sessionId}`;
const modelKeyOf = (model: Readonly<{ provider: string; id: string }>): string => `${model.provider}\u0000${model.id}`;
const currentRecallOnly = (messages: readonly HandoffMessage[]): HandoffMessage[] => {
  const latest = messages.map((_message, index) => index)
    .filter(index => (messages[index] as HandoffMessage & { customType?: string }).customType === 'pi-memory-recall').at(-1) ?? -1;
  return messages.filter((message, index) => {
    const customType = (message as HandoffMessage & { customType?: string }).customType;
    return customType !== 'pi-memory-recall' || index === latest;
  });
};

const SAFE: HandoffMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'Model-switch handoff failed safely. Pi 0.85.1 context handlers cannot cancel the network request by throwing; this replacement context is the fail-safe. Write a smaller /memory checkpoint and retry.' }],
};

export const createHandoffController = (options: {
  engine: () => Promise<MemoryEngine>;
  budget?: HandoffBudget;
} ) => {
  const budget = options.budget ?? DEFAULT_HANDOFF_BUDGET;
  const slot: {
    states: ReadonlyMap<string, HandoffState>;
    gates: ReadonlyMap<string, HandoffGate>;
    models: ReadonlyMap<string, string>;
  } = { states: new Map(), gates: new Map(), models: new Map() };
  const get = (projectId: string, sessionId: string): HandoffState | undefined => slot.states.get(keyOf(projectId, sessionId));
  const getGate = (workspace: string, sessionId: string): HandoffGate | undefined => slot.gates.get(gateKeyOf(workspace, sessionId));
  const put = (state: HandoffState): void => {
    slot.states = new Map([...slot.states, [keyOf(state.projectId, state.sessionId), state]]);
    slot.gates = new Map([...slot.gates, [gateKeyOf(state.workspace, state.sessionId), {
      workspace: state.workspace, sessionId: state.sessionId, projectId: state.projectId,
    }]]);
  };
  const clear = (): void => {
    slot.states = new Map();
    slot.gates = new Map();
    slot.models = new Map();
  };

  const observeModel = (workspace: string, sessionId: string, model: Readonly<{ provider: string; id: string }>): void => {
    slot.models = new Map([...slot.models, [gateKeyOf(workspace, sessionId), modelKeyOf(model)]]);
  };

  const activate = (projectId: string, workspace: string, sessionId: string, notice: string): void => {
    put({ projectId, workspace, sessionId, active: true, notice });
  };

  const failClosed = (workspace: string, sessionId: string, failure: string): void => {
    slot.gates = new Map([...slot.gates, [gateKeyOf(workspace, sessionId), { workspace, sessionId, failure }]]);
  };

  const persist = async (engine: MemoryEngine, sessionId: string, draft: Omit<OperationalCheckpoint, 'projectId' | 'sessionId' | 'updatedAt'>): Promise<OperationalCheckpoint> =>
    writeCheckpoint(engine, {
      ...draft, projectId: engine.scopeId, sessionId, updatedAt: new Date().toISOString(),
    });

  const refuse = (ctx: ExtensionContext, message: string): { messages: HandoffMessage[] } => {
    try { ctx.abort(); } catch { /* Pi provides a void best-effort abort; SAFE remains the primary fallback. */ }
    try { ctx.ui.notify(message, 'error'); } catch { /* A UI fault must not restore the original context. */ }
    return { messages: [SAFE] };
  };

  const boundContext = async (messages: readonly HandoffMessage[], ctx: ExtensionContext): Promise<{ messages: HandoffMessage[] }> => {
    const current = currentRecallOnly(messages);
    const sessionId = ctx.sessionManager.getSessionId();
    const gate = getGate(ctx.cwd, sessionId);
    if (!gate) return { messages: current };
    if (gate.failure) throw new Error(gate.failure);
    const engine = await options.engine();
    if (engine.scopeId !== gate.projectId) throw new Error('Handoff project changed before context selection.');
    const state = get(engine.scopeId, sessionId);
    if (!state?.active || state.workspace !== ctx.cwd) throw new Error('Handoff activation state is unavailable.');
    const checkpoint = readCheckpoint(engine, sessionId);
    const systemPrompt = ctx.getSystemPrompt();
    const selected = selectHandoffMessages(current, checkpoint, budget, {
      systemTokens: estimateHandoffTokens({ role: 'user', content: systemPrompt }),
      systemBytes: Buffer.byteLength(systemPrompt, 'utf8'),
    });
    if (!selected.ok) return refuse(ctx, selected.instruction);
    ctx.ui.notify(
      `Handoff ${selected.preTokens}→${selected.postTokens} tokens, ${selected.preBytes}→${selected.postBytes} bytes. ${selected.reason}`,
      'info',
    );
    return { messages: [...selected.messages] };
  };

  const safeContext = async (messages: readonly HandoffMessage[], ctx: ExtensionContext): Promise<{ messages: HandoffMessage[] }> => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!ctx.model) return refuse(ctx, 'Handoff refused: Pi did not expose the current model, so model-switch state cannot be verified.');
      const observedKey = gateKeyOf(ctx.cwd, sessionId);
      const currentModel = modelKeyOf(ctx.model);
      const previousModel = slot.models.get(observedKey);
      if (previousModel && previousModel !== currentModel && !getGate(ctx.cwd, sessionId)) {
        try {
          const project = await options.engine();
          activate(project.scopeId, ctx.cwd, sessionId, `Context detected model change ${previousModel} → ${currentModel}`);
        } catch (error) {
          failClosed(ctx.cwd, sessionId,
            `Context detected a model change but could not bind the project: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      observeModel(ctx.cwd, sessionId, ctx.model);
      return await boundContext(messages, ctx);
    } catch (error) {
      return refuse(ctx, `Handoff fault: ${error instanceof Error ? error.message : String(error)}. Pi 0.85.1 swallows context-handler throws (fail-open); returning a known safe bounded context.`);
    }
  };

  return { activate, failClosed, observeModel, clear, persist, safeContext, get, getGate, budget };
};

export const installHandoffHooks = (pi: ExtensionAPI, controller: ReturnType<typeof createHandoffController>, engine: () => Promise<MemoryEngine>): void => {
  pi.on('model_select', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    controller.observeModel(ctx.cwd, sessionId, event.model);
    if (!event.previousModel) return;
    const notice = `Model switch ${event.source}: ${event.previousModel.provider}/${event.previousModel.id} → ${event.model.provider}/${event.model.id}`;
    try {
      const project = await engine();
      controller.activate(project.scopeId, ctx.cwd, sessionId, notice);
      ctx.ui.notify('Bounded model-switch handoff is active for subsequent LLM calls. No extra inference was started.', 'info');
    } catch (error) {
      const failure = `Model-switch handoff could not bind the project: ${error instanceof Error ? error.message : String(error)}`;
      controller.failClosed(ctx.cwd, sessionId, failure);
      ctx.ui.notify(`${failure}. The next context will be replaced with the safe refusal.`, 'error');
    }
  });

  pi.on('context', async (event, ctx) => {
    const result = await controller.safeContext(event.messages as HandoffMessage[], ctx);
    return { messages: result.messages as typeof event.messages };
  });

  pi.on('before_provider_request', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    void engine().then(project => {
      const state = controller.get(project.scopeId, sessionId);
      if (state?.notice) ctx.ui.notify(`Handoff diagnostic (payload not logged): ${state.notice}`, 'info');
    }).catch(() => undefined);
    return undefined;
  });
};

export { assertCheckpoint, readCheckpoint, writeCheckpoint };
