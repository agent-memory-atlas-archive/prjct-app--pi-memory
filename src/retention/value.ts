import type { StoredFact } from '../storage/projection.ts';

export type ValueAssessment = Readonly<{ id: string; score: number; protected: boolean; reasons: readonly string[] }>;

export const assessValue = (fact: StoredFact, now = Date.now()): ValueAssessment => {
  const evidence = fact.evidence.some(item => item.provenance === 'native_observation') ? 30
    : fact.evidence.some(item => item.provenance === 'declared') ? 25 : fact.evidence.length ? 10 : 0;
  const judgment = ['decision', 'correction', 'constraint', 'preference'].includes(fact.kind) ? 20 : 8;
  const utility = Math.max(-25, Math.min(25, fact.usefulness * 5));
  const ageDays = Math.max(0, (now - Date.parse(fact.recordedAt)) / 86_400_000);
  const agePenalty = fact.standing === 'candidate' || fact.standing === 'needs_review' ? Math.min(25, ageDays / 3) : Math.min(10, ageDays / 90);
  const standingPenalty = fact.standing === 'contradicted' ? 45 : fact.standing === 'superseded' ? 35 : 0;
  const score = Math.max(0, Math.min(100, 35 + evidence + judgment + utility - agePenalty - standingPenalty));
  const protectedFact = fact.standing === 'supported'
    && fact.evidence.some(item => ['native_observation', 'declared'].includes(item.provenance))
    && ['decision', 'correction', 'constraint', 'preference'].includes(fact.kind);
  return { id: fact.id, score: Math.round(score), protected: protectedFact,
    reasons: [`evidence ${evidence}`, `judgment ${judgment}`, `utility ${utility}`, `age -${agePenalty.toFixed(1)}`, `standing -${standingPenalty}`] };
};
