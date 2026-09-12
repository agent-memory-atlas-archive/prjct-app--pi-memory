import type { SourceDocument } from '../contracts/documents.ts';
import { factIsValidAt } from '../contracts/memory.ts';
import type { Projection, StoredFact } from '../storage/projection.ts';
import type { VectorIndex } from '../vector/vector-index.ts';

export type MemoryQuery = Readonly<{
  queries: readonly string[];
  scopeId: string;
  asOf?: string;
  namespaces?: readonly string[];
  kinds?: readonly string[];
  limit?: number;
  maxBytes?: number;
  dense?: boolean;
  scoreThreshold?: number;
  signal?: AbortSignal;
}>;

export type MemoryHit = Readonly<{
  id: string;
  chunkId: string;
  statement: string;
  title?: string;
  uri?: string;
  namespace: string;
  source: string;
  kind: string;
  score: number;
  standing?: string;
  validAt?: string;
  invalidAt?: string;
  provenance: string;
  evidenceIds: readonly string[];
  reason: readonly string[];
}>;

export type HybridSearchResult = Readonly<{
  status: 'ok' | 'partial' | 'abstained';
  items: readonly MemoryHit[];
  gaps: readonly string[];
  omitted: number;
}>;

const tokens = (text: string): Set<string> => new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? []);
const jaccard = (a: Set<string>, b: Set<string>): number => {
  const intersection = [...a].filter(value => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
};
const GRAPH_ITEM_SCORE = 0.01;
const trustWeight = (trust: SourceDocument['trust']): number => ({ host: 1, user: 0.95, imported: 0.8, agent: 0.65 })[trust];

const addRanking = (scores: Map<string, number>, reasons: Map<string, string[]>, ids: readonly string[], label: string, weight: number): void => {
  ids.forEach((id, index) => {
    scores.set(id, (scores.get(id) ?? 0) + weight / (60 + index + 1));
    reasons.set(id, [...(reasons.get(id) ?? []), label]);
  });
};

const clipItems = (items: readonly MemoryHit[], maxBytes: number): { items: MemoryHit[]; omitted: number } => {
  const fit = items.reduce<{ items: MemoryHit[]; bytes: number; stopped: boolean }>((state, item) => {
    if (state.stopped) return state;
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    return state.bytes + bytes <= maxBytes
      ? { items: [...state.items, item], bytes: state.bytes + bytes, stopped: false }
      : { ...state, stopped: true };
  }, { items: [], bytes: 0, stopped: false });
  return { items: fit.items, omitted: items.length - fit.items.length };
};

export const hybridSearch = async (projection: Projection, vector: VectorIndex, request: MemoryQuery): Promise<HybridSearchResult> => {
  const queries = [...new Set(request.queries.map(query => query.trim()).filter(Boolean))].slice(0, 4);
  if (!queries.length) return { status: 'abstained', items: [], gaps: ['No retrieval query was provided.'], omitted: 0 };
  const limit = Math.max(1, Math.min(50, request.limit ?? 12));
  const candidateLimit = Math.max(30, limit * 8);
  const scores = new Map<string, number>();
  const reasons = new Map<string, string[]>();
  const denseGaps: string[] = [];
  for (const query of queries) {
    addRanking(scores, reasons, projection.exactSearch(query, candidateLimit).map(hit => hit.chunkId), 'exact', 2.5);
    addRanking(scores, reasons, projection.lexicalSearch(query, candidateLimit).map(hit => hit.chunkId), 'bm25', 1);
    if (request.dense !== false) {
      try {
        addRanking(scores, reasons, (await vector.search({ text: query, limit: candidateLimit, signal: request.signal })).map(hit => hit.chunkId), 'dense', 1.25);
      } catch (error) {
        denseGaps.push(`Dense retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const threshold = Math.max(0, Math.min(1, request.scoreThreshold ?? 0));
  const chunks = projection.chunks([...scores.keys()]);
  const asOf = request.asOf ? Date.parse(request.asOf) : Date.now();
  if (!Number.isFinite(asOf)) throw new Error('asOf must be ISO-8601.');
  const ranked = chunks.flatMap(chunk => {
    const document = chunk.document;
    if (document.scopeId !== request.scopeId) return [];
    if (request.namespaces?.length && !request.namespaces.includes(document.namespace)) return [];
    if (request.kinds?.length && !request.kinds.includes(document.kind)) return [];
    if (document.validFrom && Date.parse(document.validFrom) > asOf) return [];
    if (document.validTo && Date.parse(document.validTo) <= asOf) return [];
    const fact = document.namespace === 'memory' ? projection.getFact(document.externalId) : undefined;
    if (fact && !factIsValidAt(fact, asOf)) return [];
    const base = scores.get(chunk.id) ?? 0;
    const utility = fact ? Math.max(-0.25, Math.min(0.25, fact.usefulness * 0.025)) : 0;
    const evidenceBoost = fact?.evidence.some(evidence => ['native_observation', 'declared'].includes(evidence.provenance)) ? 0.08 : 0;
    const confidence = fact?.confidence ?? trustWeight(document.trust);
    const score = base * (0.65 + 0.35 * confidence) + utility + evidenceBoost;
    if (score < threshold) return [];
    const item: MemoryHit = {
      id: fact?.id ?? document.externalId, chunkId: chunk.id, statement: chunk.text,
      ...(document.title ? { title: document.title } : {}), ...(document.uri ? { uri: document.uri } : {}),
      namespace: document.namespace, source: document.source, kind: document.kind, score,
      ...(fact ? { standing: fact.standing } : {}), ...(fact?.validAt ? { validAt: fact.validAt } : {}),
      ...(fact?.invalidAt ? { invalidAt: fact.invalidAt } : {}), provenance: fact
        ? (fact.evidence.some(evidence => evidence.provenance === 'native_observation') ? 'native_observation'
          : fact.evidence.some(evidence => evidence.provenance === 'declared') ? 'declared' : 'agent_report')
        : document.trust,
      evidenceIds: fact?.evidence.map(evidence => evidence.id) ?? [], reason: reasons.get(chunk.id) ?? [],
    };
    return [{ item, tokenSet: tokens(chunk.text), fact }];
  }).sort((a, b) => b.item.score - a.item.score || a.item.id.localeCompare(b.item.id));

  // Source capping only makes sense when there is more than one source to
  // balance. Applied unconditionally it silently truncates every result set in a
  // single-source scope to limit/3 items, which costs recall and buys nothing.
  const sourceCount = new Set(ranked.map(candidate => candidate.item.source)).size;
  const perSourceCap = sourceCount > 1 ? Math.max(2, Math.ceil(limit / 3)) : limit;
  const diverse = ranked.reduce<typeof ranked>((selected, candidate) => {
    if (selected.length >= limit) return selected;
    const redundancy = selected.reduce((highest, prior) => Math.max(highest, jaccard(candidate.tokenSet, prior.tokenSet)), 0);
    const sameSource = selected.filter(prior => prior.item.source === candidate.item.source).length;
    return redundancy > 0.82 || sameSource >= perSourceCap ? selected : [...selected, candidate];
  }, []);
  // Graph neighbours carry a fixed low score, so they have to clear the same
  // threshold as everything else. Before, they were merged after the filter and
  // a caller asking for high-confidence hits got them anyway.
  const factIds = diverse.flatMap(candidate => candidate.fact?.id ?? []);
  const graph = GRAPH_ITEM_SCORE < threshold ? []
    : projection.graphNeighbors(factIds, Math.min(6, limit)).filter(fact => factIsValidAt(fact, asOf));
  const graphItems: MemoryHit[] = graph.map((fact: StoredFact) => ({
    id: fact.id, chunkId: `graph:${fact.id}`, statement: fact.statement, namespace: 'memory', source: 'graph',
    kind: fact.kind, score: GRAPH_ITEM_SCORE, standing: fact.standing, ...(fact.validAt ? { validAt: fact.validAt } : {}),
    ...(fact.invalidAt ? { invalidAt: fact.invalidAt } : {}), provenance: fact.evidence.some(item => item.provenance === 'native_observation')
      ? 'native_observation' : fact.evidence.some(item => item.provenance === 'declared') ? 'declared' : 'agent_report',
    evidenceIds: fact.evidence.map(item => item.id), reason: ['temporal-graph'],
  }));
  const unique = [...new Map([...diverse.map(candidate => candidate.item), ...graphItems].map(item => [item.id, item])).values()];
  const clipped = clipItems(unique, Math.max(512, Math.min(32_768, request.maxBytes ?? 4096)));
  const selectedRankedIds = new Set(diverse.map(candidate => candidate.item.id));
  const diversityOmitted = [...new Set(ranked.map(candidate => candidate.item.id))]
    .filter(id => !selectedRankedIds.has(id)).length;
  const omitted = diversityOmitted + clipped.omitted;
  const gaps = [...new Set(denseGaps)];
  return { status: clipped.items.length ? (gaps.length || omitted ? 'partial' : 'ok') : 'abstained',
    items: clipped.items, gaps: clipped.items.length ? gaps : [...gaps, 'No active memory matched the requested scope and time.'], omitted };
};
