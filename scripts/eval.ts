import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryEngine } from '../src/engine.ts';
import { TransformerEmbeddingProvider } from '../src/vector/providers.ts';
import { sha256 } from '../src/workspace/project-identity.ts';
import { retrievalMetrics } from '../tests/eval/metrics.ts';

type Doc = { type: 'document'; id: string; kind: string; text: string; trust: 'host' | 'user' | 'agent' | 'imported'; validTo?: string };
type Case = { type: 'query'; query: string; expansions?: string[]; positives: string[] };
type Metrics = { queries: number; recallAt10: number; mrr: number; ndcgAt10: number };

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const suite = resolve(arg('--suite') ?? 'tests/fixtures/retrieval-gold.jsonl');
const rows = (await readFile(suite, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Doc | Case);
const docs = rows.filter((row): row is Doc => row.type === 'document');
const cases = rows.filter((row): row is Case => row.type === 'query');

const hash = (text: string): number[] => {
  const vector = Array.from({ length: 256 }, () => 0);
  const normalized = ` ${text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  for (const size of [3, 4, 5]) for (let i = 0; i <= normalized.length - size; i++) {
    const gram = normalized.slice(i, i + size);
    const digest = Number.parseInt(sha256(gram).slice(0, 8), 16);
    vector[digest % vector.length] += digest & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
};
const cosine = (a: number[], b: number[]): number => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
const rrf = (lists: string[][]): string[] => {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + index)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
};
const metrics = (rankings: string[][]): Metrics => {
  const measured = retrievalMetrics(rankings, cases.map(item => new Set(item.positives)), 10);
  return { queries: measured.queries, recallAt10: measured.recallAtK, mrr: measured.mrr, ndcgAt10: measured.ndcgAtK };
};

const root = await mkdtemp(join(tmpdir(), 'pi-memory-eval-'));
const provider = new TransformerEmbeddingProvider();
const engine = new MemoryEngine({ root, scopeId: 'p_eval', sessionId: 'eval', provider });
try {
  for (const doc of docs) await engine.index({ namespace: 'gold', externalId: doc.id, scopeId: 'p_eval', scopeKind: 'project',
    source: 'gold', kind: doc.kind, title: doc.id, text: doc.text, version: sha256(doc.text), contentHash: sha256(doc.text),
    observedAt: '2026-01-01T00:00:00.000Z', ...(doc.validTo ? { validTo: doc.validTo } : {}), trust: doc.trust, metadata: {} });
  const docVectors = new Map(docs.map(doc => [doc.id, hash(doc.text)]));
  const lexical = cases.map(item => engine.projection.lexicalSearch(item.query, 100).map(hit => engine.projection.chunks([hit.chunkId])[0]?.document.externalId).filter((id): id is string => !!id));
  const hashing = cases.map(item => [...docVectors].map(([id, vector]) => ({ id, score: cosine(hash(item.query), vector) })).sort((a, b) => b.score - a.score).map(row => row.id));
  const fused = lexical.map((ranking, index) => rrf([ranking, hashing[index]!.slice(0, 10)]));
  const candidateNoExpansion = [] as string[][];
  const candidate = [] as string[][];
  for (const item of cases) {
    candidateNoExpansion.push((await engine.search({ queries: [item.query], dense: true, limit: 10, maxBytes: 16384 })).items.map(hit => hit.id));
    candidate.push((await engine.search({ queries: [item.query, ...(item.expansions ?? [])], dense: true, limit: 10, maxBytes: 16384 })).items.map(hit => hit.id));
  }
  const report = { bm25: metrics(lexical), hashing: metrics(hashing), fused: metrics(fused),
    candidateNoExpansion: metrics(candidateNoExpansion), candidate: metrics(candidate) };
  const worstCases = cases.map((item, index) => ({ query: item.query, positive: item.positives[0],
    candidateRank: candidate[index]!.findIndex(id => item.positives.includes(id)) + 1,
    fusedRank: fused[index]!.findIndex(id => item.positives.includes(id)) + 1,
    top: candidate[index]!.slice(0, 3) })).filter(item => item.candidateRank !== 1);
  const best = [report.bm25, report.hashing, report.fused].sort((a, b) => b.ndcgAt10 - a.ndcgAt10)[0]!;
  const passed = report.candidate.ndcgAt10 >= best.ndcgAt10 * 1.2
    && report.candidate.recallAt10 >= best.recallAt10 && report.candidate.mrr >= best.mrr;
  console.log(JSON.stringify({ suite, corpus: docs.length, ...report, worstCases, gate: { passed, requiredNdcgAt10: best.ndcgAt10 * 1.2 } }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
}
