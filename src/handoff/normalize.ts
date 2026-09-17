import { toolCallIds, type HandoffMessage } from './turns.ts';

/**
 * Align the tool flow with what Pi 0.85.1 actually transports
 * (`pi-ai/dist/api/transform-messages.js`): errored or aborted assistant
 * messages are skipped, and a tool call left without a result gets a synthetic
 * "No result provided" error result before the next assistant or user message.
 * Without this, one dropped connection mid tool call (`stopReason: 'error'`)
 * made every later request in the session refuse as an unmatched tool call.
 *
 * Results whose call is not in the retained history are dropped, since no
 * provider accepts them. Duplicate results are left for the caller to refuse.
 * Unchanged messages keep their identity.
 */
const isFailedAssistant = (message: HandoffMessage): boolean => {
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return message.role === 'assistant' && (stopReason === 'error' || stopReason === 'aborted');
};

const isResult = (message: HandoffMessage): boolean => message.role === 'toolResult' || message.role === 'tool';

const toolNameOf = (message: HandoffMessage, id: string): string => {
  const block = Array.isArray(message.content)
    ? (message.content as { type?: unknown; id?: unknown; name?: unknown }[]).find(item => item?.type === 'toolCall' && item.id === id)
    : undefined;
  return typeof block?.name === 'string' ? block.name : 'tool';
};

export const normalizeToolFlow = (messages: readonly HandoffMessage[]): readonly HandoffMessage[] => {
  const known = new Set(messages.filter(message => !isFailedAssistant(message)).flatMap(toolCallIds));
  const output: HandoffMessage[] = [];
  const open: { owner?: HandoffMessage; ids: string[]; answered: Set<string> } = { ids: [], answered: new Set() };
  const settle = (): void => {
    const owner = open.owner;
    if (owner) {
      for (const id of open.ids.filter(id => !open.answered.has(id))) {
        output.push({
          role: 'toolResult', toolCallId: id, toolName: toolNameOf(owner, id),
          content: [{ type: 'text', text: 'No result provided' }], isError: true,
          ...(typeof owner.timestamp === 'number' ? { timestamp: owner.timestamp } : {}),
        } as HandoffMessage);
      }
    }
    open.owner = undefined;
    open.ids = [];
    open.answered = new Set();
  };
  for (const message of messages) {
    if (isFailedAssistant(message)) continue;
    if (message.role === 'assistant') {
      settle();
      const ids = toolCallIds(message);
      if (ids.length) {
        open.owner = message;
        open.ids = [...ids];
      }
    } else if (message.role === 'user') {
      settle();
    } else if (isResult(message)) {
      if (!message.toolCallId || !known.has(message.toolCallId)) continue;
      open.answered.add(message.toolCallId);
    }
    output.push(message);
  }
  settle();
  const changed = output.length !== messages.length || output.some((message, index) => message !== messages[index]);
  return changed ? output : messages;
};
