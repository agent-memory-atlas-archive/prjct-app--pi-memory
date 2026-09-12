import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryEngine } from '../src/engine.ts';
import type { EmbeddingProvider } from '../src/vector/providers.ts';
import { sha256 } from '../src/workspace/project-identity.ts';

const numberArg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const count = Math.min(1_000_000, numberArg('--documents', 5_000));
const queryCount = Math.min(10_000, numberArg('--queries', 1_000));
const dims = 384;

// Deterministic stand-in for an embedding model. Every chunk gets a DISTINCT
// unit vector derived from its own text — a benchmark whose vectors are all
// identical measures nothing about KNN behaviour. Inference itself is
// deliberately near-free so the reported throughput is the cost of the STORAGE
// path; a real local encoder is orders of magnitude slower and would dominate,
// which is why model time is reported separately rather than folded in here.
class BenchEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'bench-deterministic-v1';
  readonly isLocal = true;
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(text => {
      const seed = sha256(text);
      const raw = Array.from({ length: dims }, (_, index) =>
        Number.parseInt(seed.slice((index * 2) % 62, (index * 2) % 62 + 2), 16) / 255 - 0.5
        + Math.sin(index * 12.9898 + seed.charCodeAt(index % seed.length)) * 0.5);
      const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1;
      return raw.map(value => value / norm);
    });
  }
}

// A seeded generator so runs are comparable. Word frequencies follow a Zipf-like
// curve over a few thousand terms, because that is what governs lexical search
// cost: a corpus drawn uniformly from a 60-word vocabulary makes every term
// match nearly every chunk, which is as unrepresentative in its own way as the
// 22-byte strings this replaced.
const vocabulary = Array.from({ length: 4_000 }, (_, index) => `term${index.toString(36)}`);
const common = ('the a of to and in that is for with on as by from at it this be are was '
  + 'project system memory record search index document chunk query result value change').split(' ');
const nextSeed = (value: number): number => (value * 1_103_515_245 + 12_345) % 2_147_483_648;
const proseFor = (index: number): string => {
  const state = { seed: nextSeed(index + 1) };
  const words = Array.from({ length: 170 }, () => {
    state.seed = nextSeed(state.seed);
    const roll = state.seed / 2_147_483_648;
    // ~45% of tokens are function words, the rest skew hard toward the head of
    // a long tail — the shape real prose has.
    if (roll < 0.45) return common[Math.floor(roll / 0.45 * common.length)]!;
    const rank = Math.floor(vocabulary.length * ((roll - 0.45) / 0.55) ** 3);
    return vocabulary[Math.min(vocabulary.length - 1, rank)]!;
  });
  const sentences = Array.from({ length: Math.ceil(words.length / 17) }, (_, group) =>
    `${words.slice(group * 17, group * 17 + 17).join(' ')}.`);
  return `Topic ${index % 997}. ${sentences.join(' ')}`;
};

const root = await mkdtemp(join(tmpdir(), 'pi-memory-bench-'));
const provider = new BenchEmbeddingProvider();
const engine = new MemoryEngine({ root, scopeId: 'p_bench', sessionId: 'bench', provider });
const path = join(root, 'index.sqlite');
try {
  const documents = Array.from({ length: count }, (_, index) => {
    const text = proseFor(index);
    return { namespace: 'bench', externalId: `doc_${String(index).padStart(12, '0')}`, scopeId: 'p_bench', scopeKind: 'project' as const,
      source: 'bench', kind: 'document', title: `benchmark ${index}`, text, version: sha256(text), contentHash: sha256(text),
      observedAt: new Date(0).toISOString(), trust: 'host' as const, metadata: { topic: String(index % 997) } };
  });

  // Both real ingest paths, measured separately so the durability trade-off is
  // visible instead of implied. index() fsyncs per document; indexAll() fsyncs
  // once per batch. A sample of the single-document path is enough — at ~4 ms of
  // fsync each, running the whole corpus through it just burns wall clock.
  const sampleSize = Math.min(200, count);
  const singleStart = performance.now();
  for (const document of documents.slice(0, sampleSize)) await engine.index({ ...document, externalId: `single_${document.externalId}` });
  const singleMs = performance.now() - singleStart;

  const batchSize = 500;
  const writeStart = performance.now();
  const ingested = [] as number[];
  for (const start of Array.from({ length: Math.ceil(count / batchSize) }, (_, index) => index * batchSize)) {
    ingested.push((await engine.indexAll(documents.slice(start, start + batchSize))).chunks);
  }
  const writeMs = performance.now() - writeStart;
  const chunkTotal = ingested.reduce((sum, value) => sum + value, 0);

  // Queries drawn from the corpus itself, so they land inside the distribution
  // the index actually holds rather than orthogonal to all of it.
  const queryTexts = Array.from({ length: queryCount }, (_, index) =>
    documents[(index * 7_919) % documents.length]!.text.slice(0, 180));
  const queryVectors = await provider.embed(queryTexts);
  engine.projection.vectorSearch(provider.model, dims, queryVectors[0]!, 10);

  const knn = [] as number[];
  for (const vector of queryVectors) {
    const start = performance.now();
    engine.projection.vectorSearch(provider.model, dims, vector, 10);
    knn.push(performance.now() - start);
  }
  const endToEnd = [] as number[];
  for (const text of queryTexts.slice(0, Math.min(200, queryTexts.length))) {
    const start = performance.now();
    await engine.search({ queries: [text], limit: 10, maxBytes: 16_384 });
    endToEnd.push(performance.now() - start);
  }

  const percentile = (samples: readonly number[], p: number): number => {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };
  // Fold the WAL back into the main file first: otherwise this measures write
  // churn that has not been checkpointed yet, not the resting footprint.
  engine.projection.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = (await stat(path)).size + (await stat(`${path}-wal`).catch(() => ({ size: 0 }))).size;
  const bytesPerChunk = bytes / Math.max(1, chunkTotal);
  const knnP95 = percentile(knn, 0.95);
  const report = {
    path: 'MemoryEngine.index (journal + projection + chunk + embed + vector)',
    documents: count, chunks: chunkTotal, queries: queryCount, dims,
    ingestSingle: { samples: sampleSize, msPerDocument: Number((singleMs / sampleSize).toFixed(3)),
      documentsPerSecond: Number((sampleSize / (singleMs / 1000)).toFixed(1)) },
    writeMs: Math.round(writeMs), documentsPerSecond: Number((count / (writeMs / 1000)).toFixed(1)),
    knn: { p50Ms: Number(percentile(knn, 0.5).toFixed(2)), p95Ms: Number(knnP95.toFixed(2)) },
    endToEnd: { samples: endToEnd.length, p50Ms: Number(percentile(endToEnd, 0.5).toFixed(2)),
      p95Ms: Number(percentile(endToEnd, 0.95).toFixed(2)) },
    bytes, bytesPerChunk: Number(bytesPerChunk.toFixed(1)),
    // Calibrated on this corpus at 5k documents / 10k chunks: ~7.2 KB per chunk
    // resting (the FTS vocabulary of a realistic long tail is most of it), KNN
    // p95 ~0.6 ms, whole query ~14 ms. endToEnd is dominated by FTS5 bm25
    // scoring and grows with corpus size — see the scaling note in the README.
    gate: { knnP95Under250ms: knnP95 < 250, bytesPerChunkUnder8192: bytesPerChunk < 8192,
      endToEndP95Under250ms: percentile(endToEnd, 0.95) < 250 },
  };
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(report.gate).some(passed => !passed)) process.exitCode = 1;
} finally {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
}
