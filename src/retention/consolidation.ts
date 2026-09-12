import type { StoredFact } from '../storage/projection.ts';

export type ConsolidationCandidate = Readonly<{
  canonicalId: string;
  relatedIds: readonly string[];
  similarity: number;
  action: 'review-duplicate' | 'review-contradiction';
}>;

const words = (text: string): Set<string> => new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
const similarity = (a: string, b: string): number => {
  const left = words(a);
  const right = words(b);
  const overlap = [...left].filter(word => right.has(word)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size));
};

/**
 * Mechanical candidate generation only. The active Pi agent sees these groups
 * and decides whether to emit a supersession/contradiction event.
 */
export const consolidationCandidates = (facts: readonly StoredFact[], threshold = 0.72): ConsolidationCandidate[] => {
  const pairs = facts.flatMap((fact, index) => facts.slice(index + 1).flatMap(other => {
    const score = similarity(fact.statement, other.statement);
    if (score < threshold) return [];
    const contradiction = fact.subject && other.subject && fact.subject === other.subject
      && fact.predicate && other.predicate && fact.predicate === other.predicate && fact.object !== other.object;
    const newest = Date.parse(fact.recordedAt) >= Date.parse(other.recordedAt) ? fact : other;
    const oldest = newest.id === fact.id ? other : fact;
    return [{ canonicalId: newest.id, relatedIds: [oldest.id], similarity: score,
      action: contradiction ? 'review-contradiction' as const : 'review-duplicate' as const }];
  }));
  return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 100);
};
