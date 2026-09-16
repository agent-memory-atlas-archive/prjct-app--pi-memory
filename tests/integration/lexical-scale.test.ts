import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEngine } from '../../src/engine.ts';
import { sha256 } from '../../src/workspace/project-identity.ts';
import { TestEmbeddingProvider } from '../helpers.ts';

/**
 * The document-frequency ceiling only engages above 5,000 chunks, so the gold
 * suite — 113 documents — cannot exercise it. This builds a corpus past that
 * threshold and checks the two properties the ceiling has to hold: it drops the
 * terms that carry no signal, and the answers still come back.
 */
const FILLER = 'the a of to and in that is for with on as by from at it this be are was project system record value change'.split(' ');
const nextSeed = (value: number): number => (value * 1_103_515_245 + 12_345) % 2_147_483_648;

const fillerText = (index: number): string => {
  const state = { seed: nextSeed(index + 1) };
  const words = Array.from({ length: 60 }, () => {
    state.seed = nextSeed(state.seed);
    const roll = state.seed / 2_147_483_648;
    // Every document carries the function words; a long tail supplies the rest.
    return roll < 0.5 ? FILLER[Math.floor(roll / 0.5 * FILLER.length)]! : `tail${Math.floor(2_000 * ((roll - 0.5) / 0.5) ** 3).toString(36)}`;
  });
  return `Filler ${index}. ${words.join(' ')}.`;
};

const NEEDLES: readonly (readonly [string, string, string])[] = [
  ['oauth-rotation', 'The OAuth refresh token rotation deadlock happens when two concurrent logins rotate the same family.',
    'we have a problem with the system and I need to know what was decided about the concurrent login refresh rotation deadlock'],
  ['cache-inode', 'A stale cache survived replacement because it was keyed on modification time instead of inode.',
    'the cache is returning old content, what was the result of that investigation about the inode keying'],
  ['gc-order', 'Garbage collection discards rebuildable embeddings first, then obsolete chunks, preserving supported evidence.',
    'when the system runs out of space what does the garbage collection discard first and what is preserved'],
];

test('above the ceiling threshold, ubiquitous query terms are dropped and answers still come back', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-memory-lexscale-'));
  const engine = new MemoryEngine({ root, scopeId: 'p_scale', sessionId: 's1', provider: new TestEmbeddingProvider() });
  t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });

  const document = (externalId: string, text: string, kind: string) => ({
    namespace: 'scale', externalId, scopeId: 'p_scale', scopeKind: 'project' as const, source: 'fixture', kind,
    text, version: sha256(text), contentHash: sha256(text), observedAt: '2026-01-01T00:00:00.000Z',
    trust: 'host' as const, metadata: {},
  });
  const corpus = [
    ...Array.from({ length: 6_000 }, (_, index) => document(`f${index}`, fillerText(index), 'filler')),
    ...NEEDLES.map(([id, text]) => document(id, text, 'note')),
  ];
  for (const start of Array.from({ length: Math.ceil(corpus.length / 1_000) }, (_, index) => index * 1_000)) {
    await engine.indexAll(corpus.slice(start, start + 1_000));
  }
  const chunks = engine.projection.stats().chunks;
  assert.ok(chunks > 5_000, `corpus must pass the ceiling threshold, got ${chunks}`);

  // 'the' is in essentially every chunk and carries no bm25 signal; 'inode'
  // appears in one. Only the second should survive.
  const chosen = engine.projection.selectiveTerms(['the', 'and', 'with', 'system', 'inode', 'modification']);
  assert.equal(chosen.includes('inode'), true, 'a one-document term is kept');
  assert.equal(chosen.includes('the'), false, 'a term in nearly every chunk is dropped');

  // Dropping them must not cost answers: each needle is still found by a
  // prompt-shaped query that is mostly common words.
  for (const [id, , query] of NEEDLES) {
    const found = await engine.search({ queries: [query], dense: false, limit: 10, maxBytes: 32_768 });
    assert.equal(found.items[0]?.id, id, `${id} should rank first for its own question`);
  }

  // The lexical leg never goes silent, even when every term is ubiquitous.
  assert.deepEqual(engine.projection.selectiveTerms(['the', 'and', 'with']).length, 3);
  assert.ok(engine.projection.lexicalSearch('the and with', 10).length > 0);
});
