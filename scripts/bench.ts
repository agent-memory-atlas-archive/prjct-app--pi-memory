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

// A seeded generator so runs are comparable, producing ~1.1 KB of prose per
// document. The old benchmark used 22-byte strings, which made bytes-per-chunk
// almost pure vector overhead and the disk gate meaningless.
const vocabulary = ('sqlite journal projection rebuild vector retrieval embedding chunk document memory fact evidence '
  + 'scope session writer sequence replay migration schema index lexical dense hybrid ranking diversity budget '
  + 'consolidation retention garbage collection redaction secret provenance standing temporal validity confidence '
  + 'namespace external source trust metadata observation declaration inference contradiction supersession').split(' ');
const nextSeed = (value: number): number => (value * 1_103_515_245 + 12_345) % 2_147_483_648;
const proseFor = (index: number): string => {
  const words = Array.from({ length: 170 }, (_, position) => position).reduce<{ seed: number; out: string[] }>(
    state => {
      const seed = nextSeed(state.seed);
      return { seed, out: [...state.out, vocabulary[seed % vocabulary.length]!] };
    }, { seed: nextSeed(index + 1), out: [] }).out;
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
    // Measured at 5k documents / 10k chunks of ~1.1 KB prose: ~5250 bytes per
    // chunk resting, KNN p95 ~1.2 ms. endToEnd covers the whole hybrid query and
    // grows LINEARLY with corpus size because exactSearch is a LIKE scan.
    gate: { knnP95Under250ms: knnP95 < 250, bytesPerChunkUnder6144: bytesPerChunk < 6144,
      endToEndP95Under250ms: percentile(endToEnd, 0.95) < 250 },
  };
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(report.gate).some(passed => !passed)) process.exitCode = 1;
} finally {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
}
