import type { EvidenceRef } from '../contracts/evidence.ts';
import type { TemporalFact } from '../contracts/memory.ts';
import type { SourceDocument } from '../contracts/documents.ts';
import { assertSourceDocument } from '../contracts/documents.ts';
import type { MemoryEngine } from '../engine.ts';
import { redactSecrets } from '../security/redact.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { publicationHold, stillHeld } from './store.ts';
import type { CurationPort } from '../storage/ports.ts';
import type { AnalysisProposal, AnalysisResult, CurationJob, EvidenceBundle, ProposedFact, SourceIdentity } from './types.ts';
import { admitCapture } from '../retention/capture-gate.ts';
import { assertPublishable } from './validate.ts';

const citation = (excerpt: string, identity: SourceIdentity): EvidenceRef => {
  const text = redactSecrets(excerpt).slice(0, 500);
  return {
    id: `ev_${sha256(`${identity.documentKey}\u0000${identity.revision}\u0000${text}`).slice(0, 24)}`,
    origin: 'imported_source', provenance: 'imported',
    contentHash: sha256(text), excerpt: text, observedAt: identity.observedAt,
    ...(identity.uri ? { uri: identity.uri } : {}),
  };
};

const tagsFor = (fact: ProposedFact, identity: SourceIdentity, result: AnalysisResult): Record<string, string> => ({
  epistemic: fact.epistemic,
  semanticKey: fact.semanticKey,
  sourceAdapter: identity.adapter,
  sourceRevision: identity.revision,
  sourceDocumentKey: identity.documentKey,
  analyzerProvider: result.provider,
  analyzerModel: result.model,
});

export const topicSemanticKey = (identity: SourceIdentity, topic?: { id?: string; title?: string }): string =>
  (topic?.id ?? topic?.title ?? identity.kind).trim().toLowerCase() || 'topic';

export const topicIdFor = (scopeId: string, semanticKey: string): string =>
  `topic_${sha256(`${scopeId}\u0000${semanticKey}`).slice(0, 20)}`;

export const curatedFactId = (scopeId: string, semanticKey: string, revision: string): string =>
  `mem_${sha256(`curated:${scopeId}:${semanticKey}:${revision}`).slice(0, 32)}`;

export type PreparedBatch = Readonly<{ facts: TemporalFact[]; documents: SourceDocument[]; factIds: string[]; resolves: readonly string[] }>;

export type PublishOutcome = Readonly<{
  status: 'published' | 'no_change' | 'stale';
  factIds: readonly string[];
  topicId?: string;
  outputRevision?: string;
  embeddings: number;
}>;

export const liveFence = (store: CurationPort, job: CurationJob, identity: SourceIdentity, owner: string): boolean => {
  const held = store.getJob(job.id);
  if (!stillHeld(held, owner, Date.now())) return false;
  const live = store.fingerprint(identity.documentKey);
  return Boolean(live && live.revision === job.inputRevision && live.contentHash === job.contentHash);
};

const asPrepared = (value: unknown): PreparedBatch | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { facts?: unknown; documents?: unknown; factIds?: unknown; resolves?: unknown };
  if (!Array.isArray(row.facts) || !Array.isArray(row.documents) || !Array.isArray(row.factIds)) return undefined;
  return { facts: row.facts as TemporalFact[], documents: row.documents as SourceDocument[], factIds: row.factIds as string[],
    resolves: Array.isArray(row.resolves) ? row.resolves as string[] : [] };
};

export const replayAccepted = async (engine: MemoryEngine, store: CurationPort, job: CurationJob,
  identity: SourceIdentity, owner: string, signal?: AbortSignal): Promise<PublishOutcome | undefined> => {
  const recovered = store.acceptedBatch(job.id);
  if (!recovered || recovered.sourceRevision !== job.inputRevision) return undefined;
  const prepared = asPrepared(recovered.payloads);
  if (!prepared) return undefined;
  const topicId = topicIdFor(engine.scopeId, topicSemanticKey(identity));
  const reuseJournal = recovered.state === 'committed' || recovered.state === 'sealed' || recovered.state === 'materializing' || recovered.state === 'applied';
  if (recovered.state === 'accepted') {
    const committed = store.commitBatch(recovered.id, job, identity, topicId, owner);
    if (!committed) {
      store.abortBatch(recovered.id);
      return { status: 'stale', factIds: [], embeddings: 0 };
    }
  }
  return applyCommitted(engine, store, job, identity, owner, topicId, recovered.topicExpected, prepared, recovered.id, signal, reuseJournal, !store.coverage(job.documentKey));
};

export const publishProposal = async (engine: MemoryEngine, store: CurationPort, job: CurationJob,
  identity: SourceIdentity, result: AnalysisResult, expectedTopicRevision: number, owner: string,
  sourceText = '', signal?: AbortSignal, truncated = false): Promise<PublishOutcome> => {
  const replayed = await replayAccepted(engine, store, job, identity, owner, signal);
  if (replayed) return replayed;
  if (!liveFence(store, job, identity, owner)) return { status: 'stale', factIds: [], embeddings: 0 };
  const topicId = topicIdFor(engine.scopeId, topicSemanticKey(identity, result.proposal.topic));
  const liveTopic = store.topicRevision(topicId);
  const expected = job.topicRevision !== undefined ? expectedTopicRevision : liveTopic;
  if (liveTopic !== expected) return { status: 'stale', factIds: [], embeddings: 0 };
  const allowed = new Set(store.dependents(identity.documentKey));
  const active = engine.projection.activeFacts(engine.scopeId, 1000);
  const bundle: EvidenceBundle = { identity, text: sourceText, truncated: false, currentFacts: active
    .filter(fact => fact.tags.sourceDocumentKey === identity.documentKey || allowed.has(fact.id)).slice(0, 64) };
  assertPublishable(result.proposal, bundle, allowed);
  if (result.proposal.noChange && !result.proposal.facts.some(fact => fact.action !== 'keep' && fact.action !== 'discard')) {
    return { status: 'no_change', factIds: [], embeddings: 0 };
  }
  const collected = await engine.collectPublication(async () => prepareBatch(engine, identity, result.proposal, result, allowed, active));
  const prepared: PreparedBatch = {
    facts: collected.bag.facts.length ? collected.bag.facts : collected.result.facts,
    documents: collected.bag.documents.length ? collected.bag.documents : collected.result.documents,
    factIds: collected.result.factIds,
    resolves: collected.result.resolves,
  };
  const batchId = store.acceptBatch(job, identity, topicId, expected, prepared, owner);
  if (!batchId) return { status: 'stale', factIds: [], embeddings: 0 };
  try {
    await engine.journal.appendAll([{ type: 'curation.batch.begin', batchId, sourceRevision: identity.revision }]);
    await engine.journal.appendAll([{ type: 'curation.batch.commit', batchId, sourceRevision: identity.revision, facts: [], documents: [] }]);
    if (!store.commitBatch(batchId, job, identity, topicId, owner)) {
      store.abortBatch(batchId);
      return { status: 'stale', factIds: [], embeddings: 0 };
    }
    return await applyCommitted(engine, store, job, identity, owner, topicId, expected, prepared, batchId, signal, false, !truncated);
  } catch (error) {
    const state = store.acceptedBatch(job.id)?.state;
    if (state === 'accepted' || state === 'committed') store.abortBatch(batchId);
    throw error;
  }
};

const prepareBatch = async (engine: MemoryEngine, identity: SourceIdentity,
  proposal: AnalysisProposal, result: AnalysisResult, allowed: ReadonlySet<string>, active: readonly TemporalFact[]): Promise<PreparedBatch> => {
  const factIds: string[] = [];
  const facts: TemporalFact[] = [];
  const resolves: string[] = [];
  const topicKey = topicSemanticKey(identity, proposal.topic);
  const topicId = topicIdFor(engine.scopeId, topicKey);
  const activeById = new Map(active.map(fact => [fact.id, fact]));
  for (const fact of proposal.facts.filter(item => item.action !== 'keep')) {
    if (fact.action === 'discard' && fact.id) {
      if (allowed.has(fact.id) && activeById.has(fact.id)) resolves.push(fact.id);
      continue;
    }
    const duplicate = active.find(item => item.tags.semanticKey === fact.semanticKey && item.tags.sourceAdapter === identity.adapter
      && item.tags.sourceDocumentKey === identity.documentKey);
    if (duplicate && duplicate.statement === fact.statement && duplicate.tags.sourceRevision === identity.revision) {
      factIds.push(duplicate.id);
      continue;
    }
    const admission = admitCapture({
      statement: fact.statement, kind: fact.kind,
      existing: [...active, ...facts].map(item => ({ statement: item.statement, kind: item.kind })),
    });
    if (!admission.accept) continue;
    const standing = fact.standing === 'supported' ? 'needs_review' : fact.standing;
    const explicit = (fact.supersedes ?? []).filter(id => allowed.has(id) || (fact.id && id === fact.id));
    const revise = fact.action === 'revise' && fact.id && allowed.has(fact.id) && activeById.has(fact.id) ? [fact.id] : [];
    const implicit = duplicate && duplicate.tags.sourceDocumentKey === identity.documentKey
      && Date.parse(duplicate.recordedAt) <= Date.parse(identity.observedAt) ? [duplicate.id] : [];
    const supersedes = [...new Set([...explicit, ...revise, ...implicit])].filter(id => id !== curatedFactId(engine.scopeId, fact.semanticKey, identity.revision));
    const recorded = await engine.recordFact({
      id: curatedFactId(engine.scopeId, fact.semanticKey, identity.revision),
      kind: fact.kind, statement: fact.statement, standing, confidence: fact.confidence,
      entities: [], evidence: [citation(fact.excerpt, identity)], episodeIds: [],
      tags: { ...tagsFor(fact, identity, result), topicId },
      ...(fact.subject ? { subject: fact.subject } : {}),
      ...(fact.predicate ? { predicate: fact.predicate } : {}),
      ...(fact.object ? { object: fact.object } : {}),
      ...(fact.validAt ? { validAt: fact.validAt } : { validAt: identity.validFrom ?? identity.observedAt }),
      ...(fact.invalidAt ? { invalidAt: fact.invalidAt } : identity.validTo ? { invalidAt: identity.validTo } : {}),
      ...(supersedes.length ? { supersedes } : {}),
    });
    facts.push(recorded.fact);
    factIds.push(recorded.fact.id);
  }
  const kept = proposal.facts.filter(fact => fact.action === 'keep' && fact.id).map(fact => fact.id!);
  const peers = active.filter(item => item.tags.topicId === topicId);
  const linked = [...new Set([...factIds, ...kept, ...peers.map(item => item.id)])];
  const priorTopic = engine.projection.documentByKey({ namespace: 'memory.topic', externalId: topicId });
  const sources = [...new Set([
    ...(priorTopic?.metadata.sources ?? identity.documentKey).split(',').filter(Boolean),
    identity.documentKey,
    ...peers.map(item => item.tags.sourceDocumentKey).filter(Boolean),
  ])].join(',');
  const summary = redactSecrets((proposal.topic?.summary ?? proposal.topic?.title ?? facts[0]?.statement ?? '').slice(0, 1500))
    || (proposal.conflicts.length ? `Unresolved: ${proposal.conflicts.join(' ')}` : '');
  const documents: SourceDocument[] = [];
  if (summary.trim()) {
    const topic = assertSourceDocument({
      namespace: 'memory.topic', externalId: topicId, scopeId: engine.scopeId, scopeKind: engine.scopeKind,
      source: 'pi-memory', kind: 'learning', title: proposal.topic?.title ?? identity.title ?? topicKey,
      text: summary, version: identity.revision, contentHash: sha256(summary),
      observedAt: identity.observedAt, trust: 'agent',
      ...(identity.validFrom ? { validFrom: identity.validFrom } : { validFrom: identity.observedAt }),
      ...(identity.validTo ? { validTo: identity.validTo } : {}),
      metadata: { facts: linked.join(','), adapter: identity.adapter, sourceRevision: identity.revision,
        semanticKey: topicKey, sources },
    });
    await engine.index(topic);
    documents.push(topic);
  }
  const extraKeys = [...new Set(facts.map(item => item.tags.semanticKey).filter(key => key && key !== topicKey))];
  for (const key of extraKeys) {
    const group = facts.filter(item => item.tags.semanticKey === key);
    const subId = topicIdFor(engine.scopeId, key);
    const text = redactSecrets((group[0]?.statement ?? key).slice(0, 1500));
    const subtopic = assertSourceDocument({
      namespace: 'memory.topic', externalId: subId, scopeId: engine.scopeId, scopeKind: engine.scopeKind,
      source: 'pi-memory', kind: 'learning', title: key, text,
      version: identity.revision, contentHash: sha256(text), observedAt: identity.observedAt, trust: 'agent',
      metadata: { facts: group.map(item => item.id).join(','), semanticKey: key, sources: identity.documentKey, parent: topicId },
    });
    await engine.index(subtopic);
    documents.push(subtopic);
  }
  return { facts, documents, factIds: linked, resolves };
};

const sourceMoved = (store: CurationPort, job: CurationJob, identity: SourceIdentity): boolean => {
  const live = store.fingerprint(identity.documentKey);
  return !live || live.revision !== job.inputRevision || live.contentHash !== job.contentHash;
};

const applyCommitted = async (engine: MemoryEngine, store: CurationPort, job: CurationJob, identity: SourceIdentity,
  owner: string, topicId: string, expectedTopicRevision: number, prepared: PreparedBatch,
  batchId: string, signal?: AbortSignal, reuseJournal = false, fullSource = true): Promise<PublishOutcome> => {
  const resolves = prepared.resolves.map(factId => ({ factId, standing: 'superseded' as const, rationale: 'Discarded by curated analysis' }));
  const payload = {
    type: 'curation.batch.commit' as const, batchId, sourceRevision: identity.revision,
    facts: prepared.facts, documents: prepared.documents, resolves,
  };
  try {
    engine.authorityTransaction(() => {
      if (!store.sealCommitted(batchId, job, identity, topicId, owner)) {
        store.abortBatch(batchId);
        throw new Error('stale-seal');
      }
      if (sourceMoved(store, job, identity)) {
        store.abortBatch(batchId);
        throw new Error('stale-source');
      }
      if (reuseJournal) {
        // Journal export is derived; sqlite already holds content after a prior commit.
      }
      engine.commitAuthority(payload);
      if (sourceMoved(store, job, identity) || !store.finishPublish(batchId, job, identity, topicId, Date.now(), fullSource)) {
        throw new Error('stale-finish');
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('stale-')) {
      return { status: 'stale', factIds: [], embeddings: 0 };
    }
    throw error;
  }
  const retractCreated = async (): Promise<PublishOutcome> => {
    await publicationHold.run({ store, jobId: job.id, owner, mode: 'retract' }, async () => {
      for (const fact of prepared.facts) {
        const current = engine.projection.getFact(fact.id);
        if (!current || current.standing === 'superseded' || current.standing === 'contradicted') continue;
        await engine.resolveFact(fact.id, 'superseded', 'Source changed before publication materialized');
      }
      for (const document of prepared.documents) {
        if (engine.projection.documentByKey({ namespace: document.namespace, externalId: document.externalId })) {
          await engine.remove(document.namespace, document.externalId, 'Source changed before publication materialized');
        }
      }
    });
    return { status: 'stale', factIds: [], embeddings: 0 };
  };
  await engine.journal.appendAll([payload]).catch(() => undefined);
  if (sourceMoved(store, job, identity)) return retractCreated();
  const dense = await engine.projectPublication(prepared.facts, prepared.documents, signal);
  if (sourceMoved(store, job, identity)) return retractCreated();
  return {
    status: 'published', factIds: prepared.factIds, topicId,
    outputRevision: String(store.topicRevision(topicId) || expectedTopicRevision),
    embeddings: dense ? prepared.facts.length : 0,
  };
};

export const materializeSealedBatches = async (engine: MemoryEngine, signal?: AbortSignal): Promise<void> => {
  for (const batch of engine.curation.pendingBatches()) {
    const live = engine.curation.fingerprint(batch.documentKey);
    if (!live || live.revision !== batch.sourceRevision) {
      engine.curation.abortBatch(batch.id);
      continue;
    }
    const prepared = asPrepared(batch.payloads);
    const job = engine.curation.getJob(batch.jobId);
    if (!prepared || !job) continue;
    if (batch.state !== 'materializing' && !engine.curation.claimMaterialize(batch.id) && batch.state !== 'materializing') continue;
    const resolves = prepared.resolves.map(factId => ({ factId, standing: 'superseded' as const, rationale: 'Discarded by curated analysis' }));
    try {
      engine.authorityTransaction(() => {
        if (live.revision !== engine.curation.fingerprint(batch.documentKey)?.revision) throw new Error('stale');
        engine.commitAuthority({
          type: 'curation.batch.commit', batchId: batch.id, sourceRevision: batch.sourceRevision,
          facts: prepared.facts, documents: prepared.documents, resolves,
        });
        const topicId = prepared.documents.find(document => document.namespace === 'memory.topic')?.externalId
          ?? topicIdFor(job.scopeId, topicSemanticKey(live));
        if (!engine.curation.finishPublish(batch.id, job, live, topicId)) throw new Error('stale');
      });
    } catch {
      engine.curation.abortBatch(batch.id);
      continue;
    }
    await engine.journal.appendAll([{
      type: 'curation.batch.commit', batchId: batch.id, sourceRevision: batch.sourceRevision,
      facts: prepared.facts, documents: prepared.documents, resolves,
    }]).catch(() => undefined);
    await engine.projectPublication(prepared.facts, prepared.documents, signal);
  }
};

export const invalidateDependents = async (engine: MemoryEngine, store: CurationPort, documentKeyValue: string,
  standing: 'needs_review' | 'contradicted', rationale: string, revision?: string): Promise<number> => {
  const ids = store.dependents(documentKeyValue, revision);
  const count = { n: 0 };
  for (const id of ids) {
    const fact = engine.projection.getFact(id);
    if (!fact || fact.standing === 'superseded' || fact.standing === 'contradicted') continue;
    await engine.resolveFact(id, standing, rationale);
    count.n += 1;
  }
  const remaining = engine.projection.activeFacts(engine.scopeId, 1000)
    .filter(fact => fact.tags.sourceDocumentKey !== documentKeyValue && (fact.standing !== 'superseded' && fact.standing !== 'contradicted'));
  const topicIds = [...new Set(ids.flatMap(id => {
    const fact = engine.projection.getFact(id);
    return fact?.tags.topicId ? [fact.tags.topicId] : [];
  }))];
  for (const topicId of topicIds) {
    const still = remaining.some(fact => fact.tags.topicId === topicId);
    const topic = engine.projection.documentByKey({ namespace: 'memory.topic', externalId: topicId });
    if (!still && topic && (revision === undefined || topic.metadata.sourceRevision === revision)) {
      await engine.remove('memory.topic', topicId, rationale);
      count.n += 1;
    }
  }
  return count.n;
};
