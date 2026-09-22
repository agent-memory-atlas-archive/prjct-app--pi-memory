/**
 * Stored memory is English only.
 *
 * A `statement` is injected into the `<project_memory>` block of every system
 * prompt, so a statement in another language is paid for — and translated by
 * the reading model — on every single turn. Memory is fresh instruction for
 * whatever model reads it next, so it is stored in one language.
 *
 * This module only decides *whether* text is English. What happens next is
 * translation, not refusal: see `src/curation/translator.ts`. Refusal is the
 * last resort, for when no model is reachable to translate with, because
 * storing another language is the one outcome that is never acceptable.
 *
 * Evidence is exempt and is never rewritten: an excerpt or a `userQuote` is the
 * record of what was actually said, and translating it would make the
 * provenance a lie.
 */

// Function words, not vocabulary. A statement about Spanish tooling may well
// contain Spanish nouns; what betrays a sentence written in another language is
// its glue.
const FOREIGN_FUNCTION_WORDS = new Set([
  // Spanish / Portuguese
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al', 'que', 'para',
  'por', 'con', 'sin', 'sobre', 'pero', 'porque', 'cuando', 'donde', 'como', 'esta',
  'este', 'esto', 'esa', 'ese', 'eso', 'son', 'está', 'están', 'ser', 'hay', 'muy',
  'nunca', 'siempre', 'debe', 'debemos', 'hacer', 'tiene', 'tienen', 'nos', 'les',
  'debes', 'vas', 'recuerda', 'mueve', 'agrega',
  'y', 'se', 'de', 'en', 'lo', 'su', 'sus', 'es', 'significa', 'después', 'antes',
  'não', 'uma', 'dos', 'das', 'em', 'ele', 'ela', 'isso', 'está',
  // French
  'le', 'les', 'une', 'des', 'du', 'est', 'sont', 'pour', 'avec', 'sans', 'mais',
  'parce', 'quand', 'où', 'cette', 'ces', 'nous', 'vous', 'doit', 'faire',
  // German
  'der', 'die', 'das', 'und', 'oder', 'nicht', 'ist', 'sind', 'ein', 'eine', 'auf',
  'mit', 'für', 'wird', 'werden', 'muss',
  // Italian
  'il', 'lo', 'gli', 'una', 'che', 'per', 'con', 'sono', 'questo', 'questa', 'deve',
]);

const ENGLISH_FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'not', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'without', 'from', 'by', 'at', 'as',
  'that', 'this', 'these', 'those', 'it', 'its', 'when', 'where', 'because',
  'must', 'should', 'never', 'always', 'do', 'does', 'did', 'has', 'have', 'had',
  'we', 'you', 'they', 'but', 'so', 'than', 'then', 'into', 'over', 'after',
  'before', 'only', 'each', 'every', 'any', 'no', 'use', 'uses', 'used', 'if',
]);

// Inverted punctuation is unambiguous; a lone accent is not, because English
// prose legitimately carries names, quotations and loanwords.
const UNAMBIGUOUS_FOREIGN = /[¿¡]/u;

/**
 * Identifiers, paths, URLs and code spans carry no language. Removing them
 * first is what stops `relevance.ts` aliases or a Spanish filename from
 * deciding a sentence's language.
 */
const prose = (text: string): string => text
  .replace(/`[^`]*`/gu, ' ')
  .replace(/```[\s\S]*?```/gu, ' ')
  .replace(/\bhttps?:\/\/\S+/giu, ' ')
  .replace(/[\w.-]*\/[\w./-]+/gu, ' ')
  .replace(/\b\w+[._-]\w[\w._-]*\b/gu, ' ');

const wordsOf = (text: string): string[] => prose(text)
  .toLocaleLowerCase()
  .split(/[^\p{L}]+/u)
  .filter(word => word.length > 0);

export type LanguageVerdict = Readonly<{ english: boolean; reason?: string }>;

/**
 * Conservative on purpose: silence is a pass. A short or identifier-heavy
 * statement gives too little glue to judge, and refusing to store a correct
 * memory is worse than storing one whose language could not be proven.
 */
export const englishVerdict = (text: string): LanguageVerdict => {
  const stripped = prose(text);
  if (UNAMBIGUOUS_FOREIGN.test(stripped)) return { english: false, reason: 'it uses ¿ or ¡' };
  const words = wordsOf(text);
  if (words.length < 4) return { english: true };
  const foreign = words.filter(word => FOREIGN_FUNCTION_WORDS.has(word)).length;
  const english = words.filter(word => ENGLISH_FUNCTION_WORDS.has(word)).length;
  if (foreign > english && foreign >= 2) {
    return { english: false, reason: `${foreign} non-English function words against ${english} English ones` };
  }
  return { english: true };
};

export const isEnglish = (text: string): boolean => englishVerdict(text).english;

/** Last resort when nothing can translate. The message tells the agent what to do instead. */
export const assertEnglishStatement = (field: string, text: string): void => {
  const verdict = englishVerdict(text);
  if (verdict.english) return;
  throw new Error(`${field} must be written in English (${verdict.reason}), and no model was reachable to translate it. `
    + 'Memory is stored and injected in English only. Restate the memory in English; '
    + 'keep the original wording in userQuote, which is evidence and is never translated.');
};
