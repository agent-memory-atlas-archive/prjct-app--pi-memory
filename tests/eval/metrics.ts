export type RetrievalMetrics = Readonly<{ queries: number; recallAtK: number; mrr: number; ndcgAtK: number; k: number }>;

export const retrievalMetrics = (rankings: readonly (readonly string[])[], relevant: readonly ReadonlySet<string>[], k = 10): RetrievalMetrics => {
  const cases = rankings.map((ranking, index) => {
    const truth = relevant[index] ?? new Set<string>();
    const hits = ranking.slice(0, k).filter(id => truth.has(id));
    const first = ranking.findIndex(id => truth.has(id));
    const dcg = ranking.slice(0, k).reduce((sum, id, rank) => sum + (truth.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
    const ideal = Array.from({ length: Math.min(k, truth.size) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
    return { recall: truth.size ? hits.length / truth.size : 0, rr: first < 0 ? 0 : 1 / (first + 1), ndcg: ideal ? dcg / ideal : 0 };
  });
  const divisor = Math.max(1, cases.length);
  return { queries: cases.length, k, recallAtK: cases.reduce((sum, item) => sum + item.recall, 0) / divisor,
    mrr: cases.reduce((sum, item) => sum + item.rr, 0) / divisor,
    ndcgAtK: cases.reduce((sum, item) => sum + item.ndcg, 0) / divisor };
};
