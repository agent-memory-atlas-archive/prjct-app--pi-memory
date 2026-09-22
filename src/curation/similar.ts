import type { TemporalFact } from '../contracts/memory.ts';

const STOP = new Set(('the and for with that this from into when then than not are was were has have been will would '
  + 'should must can use used using any all its our your their them they you who what which only also each per please instead').split(' '));

// Content words, cut to a five-letter stem so "implementing" and "implementation" meet.
const terms = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
  .filter(word => word.length > 2 && !STOP.has(word)).map(word => word.slice(0, 5)));

const codeSpans = (text: string): Set<string> => new Set([...text.matchAll(/`([^`]+)`/gu)].map(match => match[1]!.trim().toLowerCase()));

/** Shared content words over the smaller side, in [0,1]. */
export const termOverlap = (a: string, b: string): number => {
  const [x, y] = [terms(a), terms(b)];
  if (!x.size || !y.size) return 0;
  return [...x].filter(term => y.has(term)).length / Math.min(x.size, y.size);
};

/** Content words in a statement, after stop words. */
export const contentTermCount = (text: string): number => terms(text).size;

/**
 * True when `statement` restates a fact memory already holds. Overlap is
 * measured against the smaller side, so a rule that is contained in a broader
 * one also counts. Calibrated on real stored duplicates: paraphrased repeats
 * score 0.6–1.0, distinct rules of the same project stay below 0.45.
 */
export const nearDuplicateFact = <T extends TemporalFact>(statement: string, facts: readonly T[], threshold = 0.6): T | undefined => {
  const mine = terms(statement);
  if (mine.size < 3) return undefined;
  const code = codeSpans(statement);
  return facts.find(fact => {
    const theirs = terms(fact.statement);
    if (theirs.size < 3) return false;
    // Same sentence about a different command or name is a different rule:
    // `/mcp auth github` and `/mcp auth stripe` must both survive.
    const other = codeSpans(fact.statement);
    if (code.size && other.size && ![...code].some(span => other.has(span))) return false;
    const shared = [...mine].filter(term => theirs.has(term)).length;
    return shared >= 3 && shared / Math.min(mine.size, theirs.size) >= threshold;
  });
};
