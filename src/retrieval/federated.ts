import type { ScopeKind } from '../contracts/documents.ts';
import type { MemoryEngine } from '../engine.ts';
import { clipItems, type HybridSearchResult, type MemoryHit, type MemoryQuery } from './hybrid.ts';

/**
 * A prior, not a measurement. Reciprocal-rank scores are computed inside each
 * scope, so the best hit in a two-document team scores like the best hit in a
 * hundred-thousand-document project. Work happens in a project, so its own
 * knowledge outranks a sibling team's when everything else is equal — mildly,
 * because a team's answer to the question at hand is still the answer.
 */
export const DEFAULT_SCOPE_WEIGHTS: Readonly<Record<ScopeKind, number>> = {
  project: 1,
  team: 0.9,
  shared: 0.85,
};

export type FederatedQuery = Omit<MemoryQuery, 'scopeId'> & Readonly<{
  weights?: Partial<Record<ScopeKind, number>>;
}>;

/**
 * Searches every scope the session can see and merges the results.
 *
 * Scopes are searched concurrently: wall-clock is the slowest scope, not the
 * sum, which is what makes searching six of them affordable on every turn. A
 * scope that fails — an unreadable projection, a corrupt index — is reported as
 * a gap and the rest of the answer still arrives.
 */
export const federatedSearch = async (engines: readonly MemoryEngine[], request: FederatedQuery): Promise<HybridSearchResult> => {
  if (!engines.length) return { status: 'abstained', items: [], gaps: ['No memory scope is open.'], omitted: 0 };
  const { weights, ...query } = request;
  const scopeWeight = { ...DEFAULT_SCOPE_WEIGHTS, ...weights };
  const limit = Math.max(1, Math.min(50, query.limit ?? 12));
  const maxBytes = Math.max(512, Math.min(32_768, query.maxBytes ?? 4096));

  const searched = await Promise.all(engines.map(async engine => {
    try {
      // Each scope ranks its own candidates over the full budget; the merge
      // below is what enforces the caller's limit and byte budget once.
      const found = await engine.search({ ...query, limit, maxBytes: 32_768 });
      return { engine, found, error: undefined };
    } catch (error) {
      return { engine, found: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  const gaps = searched.flatMap(entry => entry.error
    ? [`Scope ${entry.engine.scopeKind}/${entry.engine.scopeId} is unavailable: ${entry.error}`]
    : entry.found!.gaps.map(gap => `${entry.engine.scopeKind}/${entry.engine.scopeId}: ${gap}`));

  const weighted = searched.flatMap(entry => (entry.found?.items ?? []).map(item => ({
    ...item,
    score: item.score * (scopeWeight[entry.engine.scopeKind] ?? 1),
    scopeId: entry.engine.scopeId,
    scopeKind: entry.engine.scopeKind,
  })));
  // The same document can only come from one scope, but a fact recorded in two
  // keeps the better-scoring copy.
  const best = weighted.reduce<Map<string, MemoryHit & { scopeId: string; scopeKind: ScopeKind }>>((map, item) => {
    const prior = map.get(item.id);
    if (!prior || prior.score < item.score) map.set(item.id, item);
    return map;
  }, new Map());
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const clipped = clipItems(ranked.slice(0, limit), maxBytes);
  const omitted = searched.reduce((sum, entry) => sum + (entry.found?.omitted ?? 0), 0)
    + Math.max(0, ranked.length - limit) + clipped.omitted;
  const degraded = searched.some(entry => entry.error) || clipped.omitted > 0
    || searched.some(entry => (entry.found?.gaps.length ?? 0) > 0 && entry.found!.items.length > 0);
  return {
    status: clipped.items.length ? (degraded ? 'partial' : 'ok') : 'abstained',
    items: clipped.items,
    gaps: clipped.items.length ? gaps : [...gaps, 'No active memory matched the requested scope and time.'],
    omitted,
  };
};
