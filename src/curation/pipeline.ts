import { documentKey } from '../contracts/documents.ts';
import type { SourceDocument } from '../contracts/documents.ts';
import type { MemoryEngine } from '../engine.ts';
import { sourceRevisionOf, withSourceIdentity } from '../sources/identity.ts';
import type { SourceAdapter, SourceSnapshot } from '../sources/registry.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { redactSecrets } from '../security/redact.ts';
import { identityFromDocument, jobIdFor, publicationHold, stillHeld } from './store.ts';
import type { CurationPort } from '../storage/ports.ts';
import { invalidateDependents, liveFence, materializeSealedBatches, publishProposal, replayAccepted, topicIdFor, topicSemanticKey } from './publish.ts';
import { CurationBlockError, isCuratedNamespace, type Analyzer, type CurationJob, type EvidenceBundle, type SourceIdentity } from './types.ts';

export type EnqueueResult = Readonly<{
  discovered: number; changed: number; unchanged: number; queued: number; withdrawn: number; gaps: readonly string[];
}>;

export type ProcessResult = Readonly<{
  jobId: string; outcome: string; modelCalls: number; embeddingCalls: number; inputTokens: number; outputTokens: number;
}>;

export type SharedBudgetGate = Readonly<{
  reserve(limits: { maxCallsPerDay: number; maxTokensPerDay: number }, estimate: { inputTokens: number; outputTokens: number }, at?: number):
    Readonly<{ day: string; estimatedInput: number; estimatedOutput: number }> | undefined;
  reconcile(ticket: Readonly<{ day: string; estimatedInput: number; estimatedOutput: number }>, actual: { inputTokens: number; outputTokens: number }): void;
}>;

export type ProcessOptions = Readonly<{
  analyzer?: Analyzer;
  block?: CurationBlockError;
  maxAttempts: number;
  maxInputChars: number;
  budget: { maxCallsPerDay: number; maxTokensPerDay: number };
  globalBudget?: SharedBudgetGate;
  leaseMs?: number;
  deadlineMs?: number;
  now?: number;
}>;

const backoffMs = (attempts: number): number => Math.min(15 * 60_000, 1_000 * (2 ** Math.min(12, Math.max(0, attempts))));

const snapshotOf = async (adapter: SourceAdapter, signal?: AbortSignal): Promise<SourceSnapshot> =>
  adapter.snapshot ? adapter.snapshot(signal) : adapter.scan(signal).then(documents => ({ documents, complete: false, gaps: [] as const }));

const isTokenChar = (ch: string | undefined): boolean => Boolean(ch && /[A-Za-zÀ-ɏͰ-῿0-9]/u.test(ch));

export const windowBounds = (text: string, offset: number, maxChars: number): { start: number; end: number; truncated: boolean } => {
  const total = text.length;
  const scanForward = (from: number, predicate: (char: string | undefined) => boolean): number => {
    const state = { index: from };
    while (state.index < total && predicate(text[state.index])) state.index += 1;
    return state.index;
  };
  const scanBackward = (from: number, floor: number): number => {
    const state = { index: from };
    while (state.index > floor && isTokenChar(text[state.index]) && isTokenChar(text[state.index - 1])) state.index -= 1;
    return state.index;
  };
  const raw = Math.min(Math.max(0, offset), total);
  const start = raw > 0 && raw < total && isTokenChar(text[raw]) && isTokenChar(text[raw - 1])
    ? scanForward(scanForward(raw, isTokenChar), char => char === ' ' || char === '\t') : raw;
  const budgetEnd = Math.min(total, start + Math.max(1, maxChars));
  const tokenEnd = budgetEnd < total && budgetEnd > 0 && isTokenChar(text[budgetEnd]) ? scanBackward(budgetEnd, start) : budgetEnd;
  const closed = /[.!?]/.test(text.slice(start, tokenEnd));
  const stop = text.indexOf('. ', tokenEnd);
  const nl = text.indexOf('\n', tokenEnd);
  const sentenceEnd = tokenEnd < total && !closed
    ? Math.min(stop < 0 ? total : stop + 2, nl < 0 ? total : nl + 1)
    : scanForward(tokenEnd, char => char === ' ' || char === '\t');
  return { start, end: sentenceEnd, truncated: sentenceEnd < total };
};

export const enqueueSnapshot = (engine: MemoryEngine, adapter: SourceAdapter, snapshot: SourceSnapshot, prepared: readonly SourceDocument[]): EnqueueResult => {
  if (adapter.scope.kind !== 'project' || adapter.scope.id !== engine.scopeId) {
    throw new Error(`Source adapter ${adapter.id} is not owned by project ${engine.scopeId}.`);
  }
  const store = engine.curation;
  const known = new Map(store.adapterFingerprints(adapter.id).map(item => [item.documentKey, item]));
  const identities = prepared.map(document => identityFromDocument(adapter.id, document));
  const seen = new Set(identities.map(identity => identity.documentKey));
  const changed = identities.filter(identity => {
    const previous = known.get(identity.documentKey);
    return previous?.revision !== identity.revision || previous.contentHash !== identity.contentHash;
  });
  const totals = { queued: 0 };
  const slices = Array.from({ length: Math.ceil(changed.length / 128) }, (_value, index) => changed.slice(index * 128, (index + 1) * 128));
  for (const [index, slice] of slices.entries()) {
    store.transaction(() => {
      for (const identity of slice) {
        const previous = known.get(identity.documentKey);
        store.upsertFingerprint(identity);
        store.discardOpenJobs(identity.documentKey, identity.revision);
        const topic = store.topic(topicIdFor(engine.scopeId, topicSemanticKey(identity)));
        if (previous && previous.revision !== identity.revision) {
          store.enqueue({
            id: jobIdFor(engine.scopeId, 'review', identity.documentKey, previous.revision),
            scopeId: engine.scopeId, adapter: adapter.id, documentKey: identity.documentKey,
            action: 'review', inputRevision: previous.revision, contentHash: previous.contentHash,
          });
          totals.queued += 1;
        }
        store.enqueue({
          id: jobIdFor(engine.scopeId, 'analyze', identity.documentKey, identity.revision),
          scopeId: engine.scopeId, adapter: adapter.id, documentKey: identity.documentKey,
          action: 'analyze', inputRevision: identity.revision, contentHash: identity.contentHash,
          ...(topic ? { topicRevision: String(topic.revision) } : {}),
        });
        totals.queued += 1;
      }
    });
    if (index < slices.length - 1) engine.authority.checkpoint();
  }
  // Retire unseen records only after every changed slice committed. A failed
  // partial run is resumable and cannot turn a transient ingest fault into data loss.
  const withdrawn = snapshot.complete ? [...known.values()].filter(item => !seen.has(item.documentKey)) : [];
  store.transaction(() => {
    for (const item of withdrawn) {
      store.markWithdrawn(item.documentKey);
      store.discardOpenJobs(item.documentKey, item.revision);
      store.enqueue({
        id: jobIdFor(engine.scopeId, 'withdraw', item.documentKey, item.revision),
        scopeId: engine.scopeId, adapter: adapter.id, documentKey: item.documentKey,
        action: 'withdraw', inputRevision: item.revision, contentHash: item.contentHash,
      });
      totals.queued += 1;
    }
  });
  return { discovered: prepared.length, changed: changed.length, unchanged: prepared.length - changed.length,
    queued: totals.queued, withdrawn: withdrawn.length, gaps: snapshot.gaps };
};

const documentFor = async (adapter: SourceAdapter | undefined, identity: SourceIdentity, engine: MemoryEngine,
  cache: Map<string, SourceSnapshot>, signal?: AbortSignal): Promise<SourceDocument | undefined> => {
  if (!adapter) return undefined;
  if (adapter.id === 'legacy-journal') {
    return engine.projection.documentByKey({ namespace: identity.namespace, externalId: identity.externalId });
  }
  const cached = cache.get(adapter.id);
  const snapshot = cached ?? await snapshotOf(adapter, signal);
  if (!cached) cache.set(adapter.id, snapshot);
  return snapshot.documents.find(item => documentKey(item) === identity.documentKey);
};

export const readBundle = async (adapter: SourceAdapter | undefined, identity: SourceIdentity, engine: MemoryEngine,
  maxChars: number, cache: Map<string, SourceSnapshot>, signal?: AbortSignal): Promise<EvidenceBundle> => {
  const document = await documentFor(adapter, identity, engine, cache, signal);
  if (!document?.text.trim()) throw new CurationBlockError('source_unavailable', 'Source evidence is unavailable.');
  const prepared = adapter && adapter.id !== 'legacy-journal' ? withSourceIdentity(adapter.id, document) : document;
  const revision = prepared.sync?.revision ?? sourceRevisionOf(prepared);
  const hash = sha256(document.text);
  if (hash !== identity.contentHash || document.contentHash !== identity.contentHash || revision !== identity.revision) {
    throw new CurationBlockError('stale', 'Reread evidence does not match the claimed revision.');
  }
  const redacted = redactSecrets(document.text);
  const prior = engine.curation.coverage(identity.documentKey)?.offset ?? 0;
  const bounds = windowBounds(redacted, prior, maxChars);
  const text = redacted.slice(bounds.start, bounds.end);
  const live = identityFromDocument(identity.adapter, prepared);
  const topic = engine.curation.topic(topicIdFor(engine.scopeId, topicSemanticKey(identity)));
  return {
    identity: live, text, truncated: bounds.truncated,
    window: { offset: bounds.start, end: bounds.end, total: redacted.length },
    currentFacts: engine.projection.activeFacts(engine.scopeId, 1000)
      .filter(fact => fact.tags.sourceDocumentKey === identity.documentKey || (topic && fact.tags.topicId === topic.id)),
    ...(topic ? { currentTopic: { id: topic.id, revision: topic.revision, summary: topic.summary } } : {}),
  };
};

const recoverBlocked = (store: CurationPort, options: ProcessOptions, now: number): void => {
  if (options.analyzer) {
    store.unblock('missing_model', now);
    store.unblock('missing_auth', now);
  }
  const spend = store.spend(now);
  if (spend.calls < options.budget.maxCallsPerDay && (spend.inputTokens + spend.outputTokens) < options.budget.maxTokensPerDay) {
    store.unblock('budget_exhausted', now);
  }
  store.unblock('source_unavailable', now);
};

export const processJob = async (engine: MemoryEngine, adapters: ReadonlyMap<string, SourceAdapter>,
  job: CurationJob, owner: string, options: ProcessOptions, cache: Map<string, SourceSnapshot> = new Map(),
  signal?: AbortSignal): Promise<ProcessResult> => {
  const store = engine.curation;
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? 60_000;
  const empty = { jobId: job.id, modelCalls: 0, embeddingCalls: 0, inputTokens: 0, outputTokens: 0 };
  if (job.scopeId !== engine.scopeId) return { ...empty, outcome: 'stale' };
  if (!stillHeld(job, owner, now) && !stillHeld(store.getJob(job.id), owner, now)) {
    return { ...empty, outcome: 'stale' };
  }
  const liveJob = store.getJob(job.id) ?? job;
  if (!stillHeld(liveJob, owner, now)) return { ...empty, outcome: 'stale' };
  return publicationHold.run({ store, jobId: job.id, owner, mode: 'publish' }, async () => {
  try {
  if (job.action === 'withdraw' || job.action === 'review') {
    if (!stillHeld(store.getJob(job.id), owner, Date.now())) return { ...empty, outcome: 'stale' };
    const invalidated = await invalidateDependents(engine, store, job.documentKey,
      job.action === 'withdraw' ? 'contradicted' : 'needs_review',
      job.action === 'withdraw' ? 'Source withdrawn; dependent knowledge is no longer supported.' : 'Source changed; dependent knowledge needs review.',
      job.inputRevision);
    store.touchFingerprint(job.documentKey, Date.now());
    if (!store.finish(job.id, owner, 'published', undefined, Date.now())) return { ...empty, outcome: 'stale' };
    return { ...empty, outcome: `invalidated:${invalidated}` };
  }
  if (options.block) {
    store.fail(job.id, owner, options.block.code, options.block.message, now + backoffMs(job.attempts), true, now);
    return { ...empty, outcome: options.block.code };
  }
  if (!options.analyzer) {
    store.fail(job.id, owner, 'missing_model', 'Analysis provider and model must be configured explicitly.', now + backoffMs(job.attempts), true, now);
    return { ...empty, outcome: 'missing_model' };
  }
  if (job.attempts > options.maxAttempts) {
    store.fail(job.id, owner, 'attempts_exhausted', 'Retry budget exhausted.', now + backoffMs(job.attempts), true, now);
    return { ...empty, outcome: 'attempts_exhausted' };
  }
  const adapter = adapters.get(job.adapter);
  const identity = store.fingerprint(job.documentKey);
  if (!identity || identity.revision !== job.inputRevision || identity.contentHash !== job.contentHash) {
    store.fail(job.id, owner, 'stale', 'Job input revision no longer matches the source fingerprint.', now, false, now);
    return { ...empty, outcome: 'stale' };
  }
  const recovered = await replayAccepted(engine, store, job, identity, owner, signal);
  if (recovered) {
    return { ...empty, outcome: recovered.status, embeddingCalls: recovered.embeddings };
  }
  const deadline = options.deadlineMs ? AbortSignal.timeout(options.deadlineMs) : undefined;
  const combined = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline;
  const beat = setInterval(() => { store.renew(job.id, owner, leaseMs, Date.now()); }, Math.max(1, Math.floor(leaseMs / 3)));
  try {
    store.renew(job.id, owner, leaseMs, Date.now());
    const bundle = await readBundle(adapter, identity, engine, options.maxInputChars, cache, combined);
    if (bundle.identity.revision !== job.inputRevision || bundle.identity.contentHash !== job.contentHash) {
      throw new CurationBlockError('stale', 'Reread evidence does not match the claimed revision.');
    }
    const estimateIn = Math.ceil(bundle.text.length / 4);
    const estimateOut = Math.ceil(options.maxInputChars / 8);
    const reservedAt = Date.now();
    const globalTicket = options.globalBudget?.reserve(options.budget, { inputTokens: estimateIn, outputTokens: estimateOut }, reservedAt);
    const reserved = options.globalBudget
      ? globalTicket !== undefined
      : store.reserveCall(options.budget, reservedAt, estimateIn + estimateOut);
    if (!reserved) {
      store.fail(job.id, owner, 'budget_exhausted', 'budget_exhausted', Date.now() + backoffMs(job.attempts), true, Date.now());
      return { ...empty, outcome: 'budget_exhausted' };
    }
    if (options.globalBudget) store.recordSpend({ calls: 1, inputTokens: estimateIn + estimateOut }, reservedAt);
    const result = await options.analyzer.analyze(bundle, combined);
    if (globalTicket) options.globalBudget?.reconcile(globalTicket, result.usage);
    store.recordSpend({ inputTokens: Math.max(0, result.usage.inputTokens - estimateIn), outputTokens: result.usage.outputTokens }, Date.now());
    const fresh = await readBundle(adapter, identity, engine, Number.MAX_SAFE_INTEGER, new Map(), combined).catch(() => undefined);
    if (!fresh || fresh.identity.revision !== job.inputRevision || fresh.identity.contentHash !== job.contentHash) {
      store.fail(job.id, owner, 'stale', 'stale', Date.now(), false, Date.now());
      return { ...empty, outcome: 'stale', modelCalls: 1, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    }
    store.renew(job.id, owner, leaseMs, Date.now());
    if (!stillHeld(store.getJob(job.id), owner, Date.now())) {
      return { ...empty, outcome: 'stale', modelCalls: 1, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    }
    const expectedTopic = job.topicRevision ? Number(job.topicRevision) : 0;
    const priorDrafts = store.windowDrafts(job.documentKey, job.inputRevision);
    const deferWatermark = bundle.truncated || priorDrafts.length > 0;
    const published = await publishProposal(engine, store, job, fresh.identity, result, expectedTopic, owner, bundle.text, combined, deferWatermark);
    if (published.status === 'stale') {
      store.fail(job.id, owner, 'stale', 'stale', Date.now(), false, Date.now());
      return { ...empty, outcome: 'stale', modelCalls: 1, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    }
    const offset = store.coverage(job.documentKey)?.offset ?? 0;
    const qualifications = [
      ...result.proposal.conflicts,
      ...result.proposal.facts.filter(fact => fact.epistemic === 'correction' || fact.epistemic === 'constraint' || fact.kind === 'correction')
        .map(fact => fact.statement),
    ];
    store.saveWindowDraft(job.documentKey, job.inputRevision, offset, published.factIds, qualifications, result.proposal.topic?.summary ?? '');
    store.recordSpend({ embeddingCalls: published.embeddings }, Date.now());
    const totals = { modelCalls: 1, embeddings: published.embeddings, in: result.usage.inputTokens, out: result.usage.outputTokens };
    if (!bundle.truncated && priorDrafts.length > 0) {
      const draftFacts = engine.projection.getFacts([...priorDrafts.flatMap(draft => draft.factIds), ...published.factIds]);
      const winners = new Map<string, typeof draftFacts[number]>();
      for (const fact of draftFacts) {
        const key = fact.tags.semanticKey ?? fact.id;
        const previous = winners.get(key);
        const preferCorrection = fact.kind === 'correction' || fact.tags.epistemic === 'correction';
        if (!previous || preferCorrection) winners.set(key, fact);
      }
      const keep = new Set([...winners.values()].map(fact => fact.id));
      await publicationHold.run({ store, jobId: job.id, owner, mode: 'retract' }, async () => {
        for (const fact of draftFacts) {
          if (keep.has(fact.id)) continue;
          if (fact.standing === 'superseded' || fact.standing === 'contradicted') continue;
          await engine.resolveFact(fact.id, 'superseded', 'Superseded by window synthesis');
        }
      });
      store.clearWindowDrafts(job.documentKey, job.inputRevision);
      const complete = adapter ? (await documentFor(adapter, identity, engine, cache, combined))?.text.length ?? 0 : 0;
      store.setCoverage(job.documentKey, complete, complete);
    }
    const total = adapter ? (await documentFor(adapter, identity, engine, cache, combined))?.text.length ?? 0 : 0;
    const consumed = bundle.window?.end ?? Math.min(total, (store.coverage(job.documentKey)?.offset ?? 0) + options.maxInputChars);
    const topic = store.topic(topicIdFor(engine.scopeId, topicSemanticKey(identity)));
    const sealed = store.getJob(job.id);
    if (sealed?.status !== 'published' && sealed?.status !== 'no_change') {
      store.finishWindow(job.id, owner, job.documentKey, job.adapter, job.inputRevision, job.contentHash,
        engine.scopeId, consumed, total, bundle.truncated, topic ? String(topic.revision) : undefined);
    }
    return {
      jobId: job.id, outcome: published.status, modelCalls: totals.modelCalls, embeddingCalls: totals.embeddings,
      inputTokens: totals.in, outputTokens: totals.out,
    };
  } catch (error) {
    if (error instanceof CurationBlockError) {
      store.fail(job.id, owner, error.code, error.code, Date.now() + backoffMs(job.attempts), error.code !== 'stale', Date.now());
      return { ...empty, outcome: error.code, modelCalls: error.code === 'stale' ? 0 : 1 };
    }
    store.fail(job.id, owner, 'analysis_failed', error instanceof Error ? error.message : 'analysis_failed', Date.now() + backoffMs(job.attempts), false, Date.now());
    return { ...empty, outcome: 'analysis_failed', modelCalls: 1 };
  } finally {
    clearInterval(beat);
  }
  } catch (error) {
    if (error instanceof CurationBlockError) {
      store.fail(job.id, owner, error.code, error.code, Date.now() + backoffMs(job.attempts), error.code !== 'stale', Date.now());
      return { ...empty, outcome: error.code, modelCalls: error.code === 'stale' ? 0 : 1 };
    }
    throw error;
  }
  });
};

const withLegacy = (engine: MemoryEngine, adapters: ReadonlyMap<string, SourceAdapter>): Map<string, SourceAdapter> => {
  const copy = new Map(adapters);
  if (copy.has('legacy-journal')) return copy;
  copy.set('legacy-journal', {
    id: 'legacy-journal',
    scope: { kind: engine.scopeKind, id: engine.scopeId },
    scan: async () => [...engine.projection.eachActiveDocument()].filter(document => !isCuratedNamespace(document.namespace)),
  });
  return copy;
};

export const processAvailable = async (engine: MemoryEngine, adapters: ReadonlyMap<string, SourceAdapter>,
  owner: string, options: ProcessOptions, signal?: AbortSignal): Promise<readonly ProcessResult[]> => {
  if (engine.projection.walPublicationPaused()) return [];
  await materializeSealedBatches(engine, signal);
  const now = options.now ?? Date.now();
  recoverBlocked(engine.curation, options, now);
  const resolved = withLegacy(engine, adapters);
  const cache = new Map<string, SourceSnapshot>();
  const leaseMs = options.leaseMs ?? 60_000;
  const results: ProcessResult[] = [];
  const step = async (): Promise<readonly ProcessResult[]> => {
    // Outside the preceding job's error/publication path: maintenance failure
    // cannot relabel a successfully committed job. Busy readers win immediately.
    if (signal?.aborted || engine.projection.walPublicationPaused()) return results;
    const job = engine.curation.claim(owner, leaseMs, options.now ?? Date.now());
    if (!job) {
      engine.projection.checkpointWal();
      return results;
    }
    try {
      results.push(await processJob(engine, resolved, job, owner, options, cache, signal));
    } catch (error) {
      if (signal?.aborted) {
        engine.curation.release(job.id, owner);
        return results;
      }
      throw error;
    }
    return step();
  };
  return step();
};
