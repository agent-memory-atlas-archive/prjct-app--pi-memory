import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { documentKey } from '../src/contracts/documents.ts';
import { Projection } from '../src/storage/projection.ts';
import { sha256 } from '../src/workspace/project-identity.ts';

const numberArg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const count = Math.min(1_000_000, numberArg('--documents', 100_000));
const queryCount = Math.min(10_000, numberArg('--queries', 1_000));
const dims = 384;
const root = await mkdtemp(join(tmpdir(), 'pi-memory-bench-'));
const path = join(root, 'index.sqlite');
const projection = new Projection(path);
try {
  const documents = Array.from({ length: count }, (_, index) => {
    const text = `document ${index} topic ${index % 997}`;
    return { namespace: 'bench', externalId: `doc_${String(index).padStart(12, '0')}`, scopeId: 'p_bench', scopeKind: 'project' as const,
      source: 'bench', kind: 'document', title: `benchmark ${index}`, text, version: sha256(text), contentHash: sha256(text),
      observedAt: new Date(0).toISOString(), trust: 'host' as const, metadata: { topic: String(index % 997) } };
  });
  const chunks = documents.map((document, index) => ({ id: `chk_${String(index).padStart(12, '0')}`,
    documentKey: documentKey(document), namespace: 'bench', ordinal: 0,
    text: document.text, contentHash: document.contentHash, metadata: document.metadata }));
  const writeStart = performance.now();
  projection.upsertDocuments(documents);
  projection.replaceChunksBatch(chunks);
  const batches = Array.from({ length: Math.ceil(count / 1000) }, (_, index) => chunks.slice(index * 1000, (index + 1) * 1000));
  for (const batch of batches) projection.storeVectors(batch.map(chunk => ({ chunkId: chunk.id,
    vector: Array.from({ length: dims }, (_, index) => index === chunk.ordinal % dims ? 1 : 0) })), 'bench-v1');
  const writeMs = performance.now() - writeStart;
  projection.vectorSearch('bench-v1', dims, Array.from({ length: dims }, (_, index) => index === 0 ? 1 : 0), 10);
  const durations = [] as number[];
  for (const index of Array.from({ length: queryCount }, (_, value) => value)) {
    const query = Array.from({ length: dims }, (_, dimension) => dimension === index % dims ? 1 : 0);
    const start = performance.now();
    projection.vectorSearch('bench-v1', dims, query, 10);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const percentile = (p: number): number => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] ?? 0;
  const bytes = (await stat(path)).size + (await stat(`${path}-wal`).catch(() => ({ size: 0 }))).size;
  const report = { indexedDocuments: count, indexedChunks: count, queries: queryCount, dims, writeMs: Math.round(writeMs),
    p50Ms: Number(percentile(0.5).toFixed(2)), p95Ms: Number(percentile(0.95).toFixed(2)),
    bytes, bytesPerChunk: Number((bytes / count).toFixed(1)), gate: { p95Under250ms: percentile(0.95) < 250, bytesPerChunkUnder2048: bytes / count < 2048 } };
  console.log(JSON.stringify(report, null, 2));
  if (!report.gate.p95Under250ms || !report.gate.bytesPerChunkUnder2048) process.exitCode = 1;
} finally {
  projection.close();
  await rm(root, { recursive: true, force: true });
}
