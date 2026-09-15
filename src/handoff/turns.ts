export type HandoffMessage = Readonly<{
  role: string;
  content?: unknown;
  toolCallId?: string;
  /** Compatibility with non-Pi fixtures; Pi 0.85.1 puts tool calls in content. */
  toolCalls?: readonly Readonly<{ id: string }>[];
  summary?: string;
  timestamp?: number;
}>;

export type Turn = Readonly<{
  messages: readonly HandoffMessage[];
  toolCallIds: readonly string[];
}>;

const contentToolCallIds = (content: unknown): readonly string[] => Array.isArray(content)
  ? content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const candidate = block as { type?: unknown; id?: unknown };
    return candidate.type === 'toolCall' && typeof candidate.id === 'string' && candidate.id ? [candidate.id] : [];
  })
  : [];

export const toolCallIds = (message: HandoffMessage): readonly string[] => [
  ...(message.toolCalls ?? []).map(call => call.id),
  ...contentToolCallIds(message.content),
].filter((id, index, ids) => Boolean(id) && ids.indexOf(id) === index);

export const turnIsComplete = (turn: Turn): boolean => {
  const callIds = turn.messages.flatMap(toolCallIds);
  const resultIds = turn.messages.flatMap(message =>
    (message.role === 'toolResult' || message.role === 'tool') && message.toolCallId ? [message.toolCallId] : []);
  const calls = new Set(callIds);
  const results = new Set(resultIds);
  return calls.size === callIds.length && results.size === resultIds.length
    && calls.size === results.size && [...calls].every(id => results.has(id));
};

export const groupTurns = (messages: readonly HandoffMessage[]): readonly Turn[] => {
  const turns: Turn[] = [];
  const open = { messages: [] as HandoffMessage[], ids: [] as string[], started: false };
  const flush = (): void => {
    if (!open.started && !open.messages.length) return;
    turns.push({ messages: open.messages, toolCallIds: open.ids });
    open.messages = [];
    open.ids = [];
    open.started = false;
  };
  for (const message of messages) {
    if (message.role === 'user' && open.started
      && turnIsComplete({ messages: open.messages, toolCallIds: open.ids })) flush();
    if (message.role === 'user') open.started = true;
    open.messages = [...open.messages, message];
    open.ids = [...new Set([...open.ids, ...toolCallIds(message)])];
  }
  flush();
  return turns;
};
