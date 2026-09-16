// Closed-class words are not evidence about a subject. Keep content words and
// identifiers; this is tokenization, not query expansion or a second reasoner.
const STOP_WORDS = new Set(('a an the and or of to in on at for from with by as is are was were be been being '
  + 'it its this that these those what which who whom whose when where why how do does did can could should would '
  + 'we our you your they their about other '
  + 'el la los las un una unos unas de del al y o en por para con es son fue ser se su sus que qué cuál cuáles '
  + 'quién cuándo dónde cómo nosotros nuestro nuestros tu tus').split(' '));

export const lexicalTerms = (query: string): string[] => [...new Set(
  query.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}_]+(?:[-./:][\p{L}\p{N}_]+)*/gu) ?? [],
)].filter(term => term.length > 1 && !STOP_WORDS.has(term)).slice(0, 32);
// Match unicode61's word boundaries and accent-insensitive Latin matching.
export const words = (text: string): string[] => text.toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
export const queryWords = (query: string): string[] => [...new Set(lexicalTerms(query).flatMap(words))];
export type LexicalStatistics = Readonly<{ documents: number; tokens: number; frequencies: ReadonlyMap<string, number> }>;
export type LexicalCandidate = Readonly<{ key: string; title?: string; statement: string }>;
const frequencies = (text: string): ReadonlyMap<string, number> => words(text).reduce((counts, word) =>
  counts.set(word, (counts.get(word) ?? 0) + 1), new Map<string, number>());

/**
 * BM25 with ONE set of full-corpus statistics summed across readable scopes.
 * Neither local BM25 magnitudes nor candidate-pool IDF are cross-scope quality.
 * Title term frequency receives a field weight; prose length is normalized.
 * The quality denominator is the theoretical saturated query score, not the
 * best observed hit (which might be irrelevant). The output is in [0,1].
 */
export const rankLexically = (candidates: readonly LexicalCandidate[], queries: readonly string[], scopes: readonly LexicalStatistics[]): ReadonlyMap<string, number>[] => {
  const n = scopes.reduce((sum, scope) => sum + scope.documents, 0);
  const avgLength = scopes.reduce((sum, scope) => sum + scope.tokens, 0) / Math.max(1, n);
  const features = candidates.map(candidate => ({ candidate,
    title: frequencies(candidate.title ?? ''), body: frequencies(candidate.statement), length: words(candidate.statement).length }));
  return queries.map(query => {
    const terms = queryWords(query).map(term => {
      const df = Math.min(n, scopes.reduce((sum, scope) => sum + (scope.frequencies.get(term) ?? 0), 0));
      return { term, idf: Math.log(1 + (n - df + 0.5) / (df + 0.5)) };
    });
    const ideal = terms.reduce((sum, term) => sum + term.idf * 2.2, 0);
    return new Map(features.flatMap(({ candidate, title, body, length }) => {
      const score = terms.reduce((sum, { term, idf }) => {
        const tf = 4 * (title.get(term) ?? 0) + (body.get(term) ?? 0);
        return sum + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / Math.max(1, avgLength)));
      }, 0);
      return score > 0 && ideal > 0 ? [[candidate.key, score / ideal] as const] : [];
    }));
  });
};
