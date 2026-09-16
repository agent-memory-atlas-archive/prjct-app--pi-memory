export type OracleKind = 'final-answer' | 'grounding' | 'evidence-complete' | 'unanswerable';

export type OracleCase = Readonly<{
  name: string;
  query: string;
  kind: OracleKind;
  expectedStatements: readonly string[];
  citations?: readonly string[];
}>;

export type OracleHit = Readonly<{ statement: string; excerpts?: readonly string[] }>;

export type OracleRanking = Readonly<{ reciprocalRank: number; ndcgAtK: number; firstRelevantRank?: number }>;

export type OracleScore = Readonly<{
  name: string;
  kind: OracleKind;
  recall: number;
  grounded: boolean;
  missing: readonly string[];
  passed: boolean;
}>;

export const oracleHitRelevant = (hit: OracleHit, kase: OracleCase): boolean => kase.expectedStatements.length > 0
  && kase.expectedStatements.every(statement => hit.statement.toLowerCase().includes(statement.toLowerCase()));

/** Item-level ranking diagnostic. A relevant item must independently contain
 * every required statement; query pass-rate is never labeled nDCG. */
export const rankOracle = (hits: readonly OracleHit[], kase: OracleCase, k = 10): OracleRanking => {
  if (k < 1 || !Number.isSafeInteger(k)) throw new Error('Oracle ranking cutoff must be a positive integer.');
  const index = hits.slice(0, k).findIndex(hit => oracleHitRelevant(hit, kase));
  if (index < 0) return { reciprocalRank: 0, ndcgAtK: 0 };
  const rank = index + 1;
  return { reciprocalRank: 1 / rank, ndcgAtK: 1 / Math.log2(rank + 1), firstRelevantRank: rank };
};

export const scoreOracle = (hits: readonly OracleHit[], kase: OracleCase,
  retrieval?: Readonly<{ status: string; gaps: readonly string[] }>): OracleScore => {
  const missing = kase.expectedStatements.filter(statement =>
    !hits.some(hit => hit.statement.toLowerCase().includes(statement.toLowerCase())));
  const recall = kase.expectedStatements.length ? (kase.expectedStatements.length - missing.length) / kase.expectedStatements.length : 1;
  const grounded = (kase.citations ?? []).every(citation =>
    hits.some(hit => (hit.excerpts ?? []).some(excerpt => excerpt.toLowerCase().includes(citation.toLowerCase()))));
  const passed = kase.kind === 'unanswerable'
    ? hits.length === 0 && retrieval?.status === 'abstained' && retrieval.gaps.some(gap => /insufficient evidence/iu.test(gap))
    : kase.kind === 'grounding' ? grounded && recall === 1
    : kase.kind === 'evidence-complete' ? recall === 1
    : recall === 1;
  return { name: kase.name, kind: kase.kind, recall, grounded, missing, passed };
};
