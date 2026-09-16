import type { EmbeddingProvider } from '../src/vector/providers.ts';

const concepts: Record<string, number> = {
  sqlite: 0, database: 0, db: 0, migration: 1, schema: 1, oauth: 2, authentication: 2, login: 2,
  failure: 3, error: 3, crash: 3, cache: 4, caching: 4, ui: 5, frontend: 5, button: 5,
  memory: 6, recall: 6, retrieval: 6, team: 7, agent: 7, deploy: 8, release: 8,
  prefer: 9, preference: 9, test: 10, verify: 10, correction: 11, wrong: 11,
  búsqueda: 12, search: 12, decisión: 13, decision: 13, temporal: 14, history: 14,
};

export class TestEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-semantic-v1';
  readonly isLocal = true;
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(text => {
      const vector = Array.from({ length: 16 }, () => 0);
      for (const word of text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []) {
        const index = concepts[word] ?? 15;
        vector[index] += 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map(value => value / norm);
    });
  }
}
