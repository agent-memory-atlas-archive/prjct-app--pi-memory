import type { SyncActivity, SyncRun } from '../storage/projection.ts';
import type { ProjectionPort } from '../storage/ports.ts';

/**
 * When a source is worth re-reading.
 *
 * Not a timer. A session that has been idle for an hour has produced nothing
 * for a sibling to publish, and one that has been working hard for five minutes
 * has. Sync is therefore driven by work done since the last run — turns taken,
 * tokens consumed, memories written — and every threshold is a disjunction: any
 * one of them crossing makes the adapter due.
 */
export type SyncPolicy = Readonly<{
  /** Prompts handled since the last run. */
  everyTurns?: number;
  /** Context tokens consumed since the last run. */
  everyTokens?: number;
  /** Memories written since the last run. */
  everyInserts?: number;
  /** Never re-run an adapter sooner than this, whatever the counters say. */
  minIntervalMs?: number;
  /** Nothing runs on its own when false; `/memory sync` still works. */
  enabled?: boolean;
}>;

export const DEFAULT_SYNC_POLICY: Required<SyncPolicy> = {
  everyTurns: 20,
  everyTokens: 40_000,
  everyInserts: 10,
  // A busy session can cross a counter again within seconds; scanning the
  // sibling stores that often is waste, not freshness.
  minIntervalMs: 5 * 60_000,
  enabled: true,
};

/** Session corrections should become daemon input promptly without accelerating optional source scans. */
export const PI_SESSION_SYNC_POLICY: Required<SyncPolicy> = {
  everyTurns: 8,
  everyTokens: 16_000,
  everyInserts: 4,
  minIntervalMs: 60_000,
  enabled: true,
};

export type SyncDecision = Readonly<{
  adapter: string;
  due: boolean;
  /** Why it is due, or why it is not. */
  reason: string;
  since?: SyncActivity;
}>;

const delta = (now: SyncActivity, mark: SyncActivity): SyncActivity => ({
  turns: Math.max(0, now.turns - mark.turns),
  tokens: Math.max(0, now.tokens - mark.tokens),
  inserts: Math.max(0, now.inserts - mark.inserts),
  updatedAt: now.updatedAt,
});

export const syncDecision = (adapter: string, last: SyncRun | undefined, now: SyncActivity,
  policy: Required<SyncPolicy>, at = Date.now()): SyncDecision => {
  if (!policy.enabled) return { adapter, due: false, reason: 'automatic sync is disabled' };
  if (!last) return { adapter, due: true, reason: 'never synced' };
  const waited = at - Date.parse(last.lastAt);
  if (waited < policy.minIntervalMs) {
    return { adapter, due: false, reason: `synced ${Math.round(waited / 1000)}s ago, minimum is ${Math.round(policy.minIntervalMs / 1000)}s` };
  }
  const since = delta(now, last.at);
  const crossed = [
    since.turns >= policy.everyTurns ? `${since.turns} turns` : undefined,
    since.tokens >= policy.everyTokens ? `${since.tokens} tokens` : undefined,
    since.inserts >= policy.everyInserts ? `${since.inserts} memories` : undefined,
  ].flatMap(reason => reason ?? []);
  return crossed.length
    ? { adapter, due: true, reason: `since last sync: ${crossed.join(', ')}`, since }
    : { adapter, due: false, reason: `since last sync: ${since.turns} turns, ${since.tokens} tokens, ${since.inserts} memories`, since };
};

/**
 * Which adapters are worth running now. Reads the watermark table only — no
 * source is touched until something is actually due.
 */
export const dueAdapters = (projection: ProjectionPort, adapters: readonly string[],
  policy: SyncPolicy = {}, at = Date.now()): readonly SyncDecision[] => {
  const resolved = { ...DEFAULT_SYNC_POLICY, ...policy };
  const now = projection.activity();
  return adapters.map(adapter => syncDecision(adapter, projection.syncState(adapter), now, resolved, at));
};
