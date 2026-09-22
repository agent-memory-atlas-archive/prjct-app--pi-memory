import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertEnglishStatement, englishVerdict, isEnglish } from '../src/contracts/language.ts';

test('ordinary English memories pass', () => {
  for (const statement of [
    'Retrieval abstains when no candidate clears the relevance gate.',
    'Never merge to main in pi-plan without warning: the merge publishes a release.',
    'The daemon analyzes changed sources only while Pi is closed.',
    'Use keyset pagination instead of OFFSET for the chunks table.',
    'BM25 remains the supported quality baseline until an authorized run says otherwise.',
  ]) assert.equal(isEnglish(statement), true, statement);
});

test('memories written in another language are refused', () => {
  for (const statement of [
    'La extensión nunca debe llamar a un modelo durante el turno del agente.',
    'Recuerda que el daemon solo analiza las fuentes cuando Pi está cerrado.',
    'Nunca hagas merge a main sin avisar porque publica una release.',
    'Der Daemon darf nicht automatisch gestartet werden.',
    'Le daemon ne doit jamais être lancé automatiquement par l\'extension.',
  ]) assert.equal(isEnglish(statement), false, statement);
});

test('an English sentence about non-English tooling is not mistaken for one', () => {
  for (const statement of [
    'The declaration detector accepts `recuerda`, `acuérdate` and `remember` as prefixes.',
    'The alias table in src/retrieval/relevance.ts maps `guarda` to storage.',
    'The gold suite carries one bilingual query on purpose.',
    'Spanish declarations such as "recuerda que" are captured as declared evidence.',
  ]) assert.equal(isEnglish(statement), true, statement);
});

test('inverted punctuation is decisive on its own', () => {
  const verdict = englishVerdict('¿Por qué falla el índice?');
  assert.equal(verdict.english, false);
  assert.match(verdict.reason ?? '', /¿/u);
});

test('too little prose to judge is allowed through rather than refused', () => {
  // Refusing to store a correct memory is worse than storing one whose
  // language could not be proven, so silence passes.
  assert.equal(isEnglish('sqlite-vec int8'), true);
  assert.equal(isEnglish('WAL checkpoint'), true);
  assert.equal(isEnglish(''), true);
});

test('the refusal tells the agent what to do instead', () => {
  assert.throws(() => assertEnglishStatement('statement', 'El daemon nunca se inicia solo, hay que configurarlo.'), error => {
    const message = (error as Error).message;
    assert.match(message, /must be written in English/u);
    assert.match(message, /userQuote/u);
    assert.match(message, /never translated/u);
    return true;
  });
  assert.doesNotThrow(() => assertEnglishStatement('statement', 'The daemon never starts on its own.'));
});

test('a scripted translator produces what is stored, and the original is left alone', async () => {
  const { scriptedTranslator } = await import('../src/curation/translator.ts');
  const spoken = 'El daemon nunca se inicia solo.';
  const translator = scriptedTranslator({ [spoken]: 'The daemon never starts on its own.' });
  assert.equal(await translator.toEnglish(spoken), 'The daemon never starts on its own.');
  // Unknown input passes through untouched rather than being invented.
  assert.equal(await translator.toEnglish('Already English here.'), 'Already English here.');
});
