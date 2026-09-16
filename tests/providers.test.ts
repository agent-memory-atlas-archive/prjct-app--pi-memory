import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encoderLoads, OpenAICompatibleEmbeddingProvider, residentModels, TransformerEmbeddingProvider } from '../src/vector/providers.ts';

/**
 * Concurrent project-local components may build providers for the same model.
 * They must not each load an encoder: the model is ~120 MB and carries its own
 * inference session. Persistent cache paths remain project-specific.
 */
test('providers on the same model share one loaded encoder and release it once', async () => {
  const before = residentModels();
  const loadsBefore = encoderLoads();
  // A model id that will never resolve: loading fails, but the accounting is
  // what matters and it happens before the failure surfaces.
  const providers = Array.from({ length: 6 }, () => new TransformerEmbeddingProvider('pi-memory/nonexistent-test-model'));
  // Count while the load is still in flight: a failed load evicts itself so the
  // next caller can retry, which would otherwise race this assertion.
  const embedding = providers.map(provider => provider.embed(['x']).catch(() => undefined));
  assert.equal(residentModels(), before + 1, 'six providers, one resident encoder');
  await Promise.all(embedding);
  // The count that actually proves sharing: six unshared providers would still
  // leave one map entry, but they would have loaded the encoder six times.
  assert.equal(encoderLoads(), loadsBefore + 1, 'the encoder was loaded once, not once per provider');

  // Releasing must not resurrect the load failure, however many holders there
  // were, and disposing twice must not double-decrement.
  for (const provider of providers) await provider.dispose();
  await providers[0]!.dispose();
  assert.equal(residentModels(), before);
});

test('remote providers require encrypted transport except on literal loopback', async () => {
  assert.throws(() => new OpenAICompatibleEmbeddingProvider({ model: 'm', baseUrl: 'http://example.test' }), /HTTPS/);
  const provider = new OpenAICompatibleEmbeddingProvider({ model: 'm', baseUrl: 'http://127.0.0.1:1234' });
  const prior = process.env.PI_MEMORY_OFFLINE;
  process.env.PI_MEMORY_OFFLINE = '1';
  try { await assert.rejects(provider.embed(['text']), /offline mode/); }
  finally {
    if (prior === undefined) delete process.env.PI_MEMORY_OFFLINE;
    else process.env.PI_MEMORY_OFFLINE = prior;
  }
});

test('a provider that never embeds holds nothing', async () => {
  const before = residentModels();
  const provider = new TransformerEmbeddingProvider('pi-memory/another-nonexistent-model');
  await provider.dispose();
  assert.equal(residentModels(), before);
});
