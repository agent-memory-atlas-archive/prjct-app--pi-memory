import { queryWords, words, type LexicalStatistics } from './lexical.ts';

// Small, explicit bilingual retrieval vocabulary; no model calls or answer generation.
const aliases: Readonly<Record<string, string>> = {
  database: 'storage', databases: 'storage', db: 'storage', store: 'storage', stores: 'storage',
  guarda: 'storage', guardar: 'storage', almacenamiento: 'storage', datos: 'data',
  proyecto: 'project', proyectos: 'project', projects: 'project',
  produccion: 'production', cuenta: 'account', identificador: 'id',
  commands: 'command', comandos: 'command', comando: 'command',
  oauth: 'authentication', login: 'authentication', autenticacion: 'authentication',
  fail: 'error', failure: 'error', errors: 'error', refresh: 'renewal',
};
const filler = new Set([
  'use', 'uses', 'using', 'still', 'all', 'keep', 'tell', 'please', 'give', 'about', 'base',
  'usar', 'usa', 'usamos', 'utilizar', 'utiliza', 'utilizamos', 'debo', 'debe', 'debemos', 'deben',
]);
const normalize = (terms: readonly string[]): string[] => [...new Set(terms.map(term => aliases[term] ?? term))].filter(term => !filler.has(term));

export type RelevanceCandidate = Readonly<{ key: string; text: string }>;
export const relevanceTerms = (queries: readonly string[]): string[] => [...new Set([
  ...queries.flatMap(queryWords), ...Object.keys(aliases), ...Object.values(aliases),
])];

/** A project name shared throughout a corpus is context, not evidence for an
 * unknown attribute. Focus coverage must exist before quality/confidence can
 * rank a result. Dense-only matches need a stronger floor than mere proximity.
 */
export const relevantKeys = (
  query: string, candidates: readonly RelevanceCandidate[], statistics: LexicalStatistics,
  dense: ReadonlyMap<string, number> = new Map(),
): ReadonlySet<string> => {
  const terms = normalize(queryWords(query));
  const frequency = (term: string): number => Math.max(statistics.frequencies.get(term) ?? 0,
    ...Object.entries(aliases).filter(([, target]) => target === term).map(([alias]) => statistics.frequencies.get(alias) ?? 0));
  // A corpus may discuss one subsystem almost exclusively. Preserve explicit
  // subsystem predicates even when many topic documents repeat the same fact.
  const predicates = new Set(['storage', 'command']);
  const focus = terms.filter(term => predicates.has(term) || frequency(term) / Math.max(1, statistics.documents) < 0.6);
  // Short queries and corpora consisting of one subject still have useful terms.
  const wanted = focus.length ? focus : terms;
  // Verification questions can be answered by qualified contrary evidence.
  // Attribute lookups require more coverage than yes/no verification.
  const verification = /^(?:does|do|is|are|can|¿?es|¿?son|¿?usa|¿?utiliza)\b/iu.test(query.trim());
  return new Set(candidates.filter(candidate => {
    const present = new Set(normalize(words(candidate.text)));
    const matched = wanted.filter(term => present.has(term)).length;
    const qualifiedPredicate = verification && wanted.some(term => predicates.has(term) && present.has(term))
      && /\b(?:not|no longer|instead|source of truth|rather than|no|en lugar)\b/iu.test(candidate.text);
    // Prompt-shaped queries include investigative prose absent from the answer.
    // Two independently rare corpus terms provide stronger corroboration than a
    // coverage fraction diluted by that prose (e.g. cache + inode in 6k notes).
    const rareMatches = wanted.filter(term => present.has(term) && frequency(term) > 0
      && frequency(term) / Math.max(1, statistics.documents) <= 0.01).length;
    const lexical = wanted.length > 0 && (matched / wanted.length >= (qualifiedPredicate ? 0.3 : 0.5)
      || (statistics.documents >= 100 && rareMatches >= 2));
    // Long attribute questions must not be rescued by a close embedding alone:
    // shared project/subsystem vocabulary can dominate unrelated attributes.
    // Short conceptual searches still support genuine dense-only synonyms.
    return lexical || (terms.length <= 2 && (dense.get(candidate.key) ?? 0) >= 0.6);
  }).map(candidate => candidate.key));
};
