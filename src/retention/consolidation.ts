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

/** Same statement in two languages shares almost no words, so cosine is the only
 * comparison that sees it. Vectors arrive normalized from the provider; the
 * guard keeps a denormalized one from inflating the score. */
const cosine = (a: readonly number[], b: readonly number[]): number => {
  const size = Math.min(a.length, b.length);
  const sums = { dot: 0, left: 0, right: 0 };
  for (const [i, x] of a.slice(0, size).entries()) {
    const y = b[i]!;
    sums.dot += x * y;
    sums.left += x * x;
    sums.right += y * y;
  }
  const norm = Math.sqrt(sums.left) * Math.sqrt(sums.right);
  return norm > 0 ? sums.dot / norm : 0;
};

/** Pairing is identical whichever comparison produced the score: the newest fact
 * is the canonical one, and a same subject+predicate with a different object is
 * a contradiction rather than a repetition. */
const pairsFrom = (facts: readonly StoredFact[], score: (a: number, b: number) => number,
  threshold: number): ConsolidationCandidate[] =>
  facts.flatMap((fact, index) => facts.slice(index + 1).flatMap((other, offset) => {
    const value = score(index, index + 1 + offset);
    if (value < threshold) return [];
    const contradiction = fact.subject && other.subject && fact.subject === other.subject
      && fact.predicate && other.predicate && fact.predicate === other.predicate && fact.object !== other.object;
    const newest = Date.parse(fact.recordedAt) >= Date.parse(other.recordedAt) ? fact : other;
    const oldest = newest.id === fact.id ? other : fact;
    return [{ canonicalId: newest.id, relatedIds: [oldest.id], similarity: value,
      action: contradiction ? 'review-contradiction' as const : 'review-duplicate' as const }];
  }));

/** One row per unordered pair, best score wins, strongest first. */
const rank = (candidates: readonly ConsolidationCandidate[]): ConsolidationCandidate[] => {
  const best = new Map<string, ConsolidationCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.canonicalId, ...candidate.relatedIds].sort().join('\u0000');
    const current = best.get(key);
    if (!current || candidate.similarity > current.similarity) best.set(key, candidate);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 100);
};

/**
 * Mechanical candidate generation only. The active Pi agent sees these groups
 * and decides whether to emit a supersession/contradiction event.
 */
export const consolidationCandidates = (facts: readonly StoredFact[], threshold = 0.72): ConsolidationCandidate[] =>
  rank(pairsFrom(facts, (a, b) => similarity(facts[a]!.statement, facts[b]!.statement), threshold));

export type SemanticConsolidationOptions = Readonly<{
  embed: (texts: readonly string[]) => Promise<number[][]>;
  /** Cosine floor; see DEFAULT_SEMANTIC_THRESHOLD for how it was calibrated. */
  threshold?: number;
  /** The word-overlap pass still runs, so nothing the lexical comparison caught is lost. */
  lexicalThreshold?: number;
  /** Embedding is one batch, but pairing is quadratic; the newest facts are the ones worth comparing. */
  maxFacts?: number;
}>;

/**
 * Calibrado contra duplicados reales con Xenova/paraphrase-multilingual-MiniLM-L12-v2,
 * el mismo encoder que carga la busqueda densa:
 *
 *   la misma regla en dos idiomas     0.700 - 0.915
 *   una regla distinta pero vecina    0.492 - 0.596   <- debe quedar fuera
 *   enunciados sin relacion          -0.027 - 0.262
 *
 * 0.65 cae en el hueco entre el vecino mas parecido y el duplicado mas flojo.
 * Un umbral de 0.82 solo veia los duplicados dentro del mismo idioma, que es
 * justo el caso que el comparador lexico ya cubria.
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.65;

/**
 * Lexical union semantic. The word-overlap pass cannot see "mueve el ticket a
 * ready to verify" and "move the ticket to ready to verify" as the same rule:
 * they share no words. The multilingual encoder already shipped for dense
 * search does, so the same knowledge stops living in the snapshot four times.
 *
 * Falls back to the lexical result alone when embedding is unavailable, so an
 * offline or model-less project keeps exactly the behaviour it had.
 */
export const semanticConsolidationCandidates = async (facts: readonly StoredFact[],
  options: SemanticConsolidationOptions): Promise<ConsolidationCandidate[]> => {
  const lexical = consolidationCandidates(facts, options.lexicalThreshold ?? 0.72);
  const considered = [...facts]
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
    .slice(0, options.maxFacts ?? 400);
  if (considered.length < 2) return lexical;
  const vectors = await options.embed(considered.map(fact => fact.statement)).catch(() => undefined);
  if (!vectors) return lexical;
  if (vectors.length !== considered.length) return lexical;
  const semantic = pairsFrom(considered, (a, b) => cosine(vectors[a]!, vectors[b]!),
    options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD);
  return rank([...lexical, ...semantic]);
};
