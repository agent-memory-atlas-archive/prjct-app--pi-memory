/**
 * The link to pi-context-prune, which removes superseded memory from the
 * request payload. It is a separate extension because it works on the provider
 * payload, not on memory; /memory is where a person reaches it. Pi loads each
 * extension with its own module graph, so the two meet on a process symbol.
 */
export type ContextPruneStatus = Readonly<{ inContext: number; pruned: number; queued: boolean }>;
export type ContextPrune = Readonly<{
  /** Remove every superseded memory block on the next request. */
  queue(ctx: unknown): void;
  status(): ContextPruneStatus;
}>;

const KEY = Symbol.for('prjct.context-prune');

export const contextPrune = (): ContextPrune | undefined => {
  const host = (globalThis as unknown as Record<symbol, { memory?: ContextPrune } | undefined>)[KEY]?.memory;
  return typeof host?.queue === 'function' && typeof host.status === 'function' ? host : undefined;
};

const short = (tokens: number): string => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/** One line for the panel and the command: what is in context and what was removed. */
export const contextLine = (status: ContextPruneStatus | undefined): string => status
  ? `${short(status.inContext)} tok in context · ${short(status.pruned)} pruned${status.queued ? ' · prune queued' : ''}`
  : 'pi-context-prune not loaded';

/** Queue the prune, or say why it cannot run. */
export const queueContextPrune = (ctx: unknown): string => {
  const prune = contextPrune();
  if (!prune) return 'pi-context-prune is not loaded, so nothing can be pruned from context.';
  prune.queue(ctx);
  return `Prune queued for the next request · keeps the latest snapshot and recall · ${contextLine(prune.status())}`;
};
