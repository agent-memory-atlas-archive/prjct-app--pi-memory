import type { MemoryKind } from '../contracts/memory.ts';
import type { MemoryEngine } from '../engine.ts';
import type { MemorySearch } from './hooks.ts';

/**
 * What a child agent (a subagent or a Team Expert) may read from project memory.
 *
 * A child is started to judge something with its own eyes. Facts about the
 * terrain — where things live, how to run them, what breaks, which rules hold —
 * save it rediscovery without steering it. Verdicts do steer it: a decision's
 * reasoning or a past learning anchors a reviewer to accept what it was asked
 * to check. So the cut is by kind, per role, and it lives here, once, because
 * every consumer of this view would otherwise keep its own copy of the rule.
 *
 * The view never writes. What a child reports is unverified; the parent and the
 * curator decide what becomes memory.
 */
export type ChildRole = 'worker' | 'explorer' | 'reviewer';

const TERRAIN: readonly MemoryKind[] = ['fact', 'constraint', 'procedure', 'failure', 'correction'];

export const CHILD_KINDS: Readonly<Record<ChildRole, readonly MemoryKind[]>> = {
  explorer: TERRAIN,
  // A worker must obey decisions and preferences; it gets them as statements, not as arguments.
  worker: [...TERRAIN, 'decision', 'preference'],
  // A reviewer judges from scratch: only the rules it must hold the work to and how to check it.
  reviewer: ['constraint', 'procedure'],
};

export const CHILD_ROLES: readonly ChildRole[] = ['worker', 'explorer', 'reviewer'];
export const isChildRole = (value: unknown): value is ChildRole => CHILD_ROLES.includes(value as ChildRole);

export type ChildNote = Readonly<{ kind: string; statement: string }>;
export type ChildMemory = Readonly<{
  role: ChildRole;
  /** Supported constraints: few, always shown. */
  rules: readonly string[];
  /** Memories of the role's kinds that match the query. */
  notes: readonly ChildNote[];
  /** The rendered block, empty when there is nothing to say. */
  text: string;
}>;

export type ChildViewRequest = Readonly<{ role: ChildRole; query?: string; maxBytes?: number; signal?: AbortSignal }>;
export type ChildView = (request: ChildViewRequest) => Promise<ChildMemory>;

const RULES_MAX = 12;
const RULES_BYTES = 1200;
const NOTES_BYTES = 1500;

// Stored text is data: it must not be able to close the block it is rendered in.
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim().replaceAll('<', '\\u003c');

const within = (lines: readonly string[], maxBytes: number): string[] => {
  const kept: string[] = [];
  const used = { bytes: 0 };
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used.bytes + size > maxBytes) break;
    kept.push(line);
    used.bytes += size;
  }
  return kept;
};

export const renderChildMemory = (role: ChildRole, rules: readonly string[], notes: readonly ChildNote[]): string => {
  if (!rules.length && !notes.length) return '';
  return [
    `<project_memory for="${role}">`,
    'Records about this project, not conclusions about your task. Check anything that matters against the code.',
    ...(rules.length ? ['Rules that hold here:', ...rules.map(rule => `- ${rule}`)] : []),
    ...(notes.length ? ['Notes that match this task:', ...notes.map(note => `- (${note.kind}) ${note.statement}`)] : []),
    '</project_memory>',
  ].join('\n');
};

const EMPTY = (role: ChildRole): ChildMemory => ({ role, rules: [], notes: [], text: '' });

/**
 * Only supported facts reach a child: an unreviewed candidate is exactly the
 * kind of unverified claim a child must not inherit as truth.
 */
export const createChildView = (deps: Readonly<{
  engine: () => Promise<MemoryEngine | undefined>;
  search: MemorySearch;
}>): ChildView => async request => {
  const { role } = request;
  if (!isChildRole(role)) throw new Error(`Unknown child role: ${String(role)}`);
  const engine = await deps.engine().catch(() => undefined);
  if (!engine) return EMPTY(role);
  const allowed = CHILD_KINDS[role];
  const rules = within(engine.projection.activeFacts(engine.scopeId, 200)
    .filter(fact => fact.kind === 'constraint' && fact.standing === 'supported')
    .map(fact => oneLine(fact.statement)), RULES_BYTES).slice(0, RULES_MAX);
  const query = request.query?.trim();
  const found = query
    ? await deps.search({ queries: [query], namespaces: ['memory'], kinds: allowed, limit: 8,
      maxBytes: request.maxBytes ?? NOTES_BYTES, dense: false, ...(request.signal ? { signal: request.signal } : {}) })
      .catch(() => undefined)
    : undefined;
  const shown = new Set(rules);
  const notes = (found?.items ?? [])
    .filter(item => allowed.includes(item.kind as MemoryKind) && (item.standing ?? 'supported') === 'supported')
    .map(item => ({ kind: item.kind, statement: oneLine(item.statement) }))
    .filter(note => !shown.has(note.statement));
  return { role, rules, notes, text: renderChildMemory(role, rules, notes) };
};

/**
 * Pi loads each extension with its own module graph, so pi-subagents and
 * pi-team cannot import this file and share state with it. A well-known symbol
 * on `globalThis` is the one object they all see (the same pattern as
 * `prjct.agents` in pi-subagents).
 */
const KEY = Symbol.for('prjct.memory');

export type MemoryHost = { childView?: ChildView };

export const publishChildView = (view: ChildView): void => {
  const space = globalThis as unknown as Record<symbol, MemoryHost | undefined>;
  space[KEY] = { ...(space[KEY] ?? {}), childView: view };
};
