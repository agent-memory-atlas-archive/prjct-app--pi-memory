import { tryCreateSdkAnalyzer } from '../curation/analyzer.ts';
import { processAvailable } from '../curation/pipeline.ts';
import { jobIdFor } from '../curation/store.ts';
import { CurationBlockError, type Analyzer } from '../curation/types.ts';
import { MemoryEngine } from '../engine.ts';
import { registerKnownSources } from '../sources/install.ts';
import { SourceRegistry, type SourceAdapter } from '../sources/registry.ts';
import { trustedProjectIds } from '../workspace/project-identity.ts';
import type { DaemonConfig } from './config.ts';
import { GlobalBudgetLedger } from './budget.ts';

export type CycleReport = Readonly<{
  scopes: number;
  queued: number;
  processed: number;
  modelCalls: number;
  embeddingCalls: number;
  inputTokens: number;
  outputTokens: number;
  blocked?: string;
  failedScopes?: number;
}>;

export type CycleOptions = Readonly<{
  config: DaemonConfig;
  owner: string;
  analyzer?: Analyzer;
  block?: CurationBlockError;
  engines?: readonly MemoryEngine[];
  extraAdapters?: readonly SourceAdapter[];
  signal?: AbortSignal;
}>;

export const discoverProjectIds = async (home: string): Promise<string[]> => [...await trustedProjectIds(home)];

export const registryFor = async (engine: MemoryEngine, home: string): Promise<SourceRegistry> => {
  const registry = new SourceRegistry();
  if (engine.scopeKind !== 'project') return registry;
  await registerKnownSources(registry, engine.scopeId, { home });
  return registry;
};

const enqueueDueReviews = (engine: MemoryEngine, adapterId: string, now: number, maxReviewAgeMs: number): number => {
  const added = { n: 0 };
  const open = new Set(engine.curation.openJobs().map(job => `${job.action}:${job.documentKey}`));
  for (const identity of engine.curation.adapterFingerprints(adapterId)) {
    const expired = Boolean(identity.validTo && Date.parse(identity.validTo) <= now);
    const aged = (engine.curation.fingerprintAgeMs(identity.documentKey, now) ?? 0) > maxReviewAgeMs;
    if (!expired && !aged) continue;
    const action = expired ? 'review' as const : 'analyze' as const;
    if (open.has(`${action}:${identity.documentKey}`)) continue;
    const reason = expired ? 'expired' : 'age';
    engine.curation.enqueue({
      id: jobIdFor(engine.scopeId, action, identity.documentKey, `${identity.revision}:${reason}`),
      scopeId: engine.scopeId, adapter: adapterId, documentKey: identity.documentKey,
      action, inputRevision: identity.revision, contentHash: identity.contentHash,
    });
    added.n += 1;
  }
  return added.n;
};

const processProject = async (engine: MemoryEngine, options: CycleOptions, totals: {
  queued: number; processed: number; modelCalls: number; embeddingCalls: number; inputTokens: number; outputTokens: number;
}, globalBudget: GlobalBudgetLedger): Promise<void> => {
  if (engine.scopeKind !== 'project') throw new Error('Memory opens only a project-owned database.');
  options.signal?.throwIfAborted();
  const registry = await registryFor(engine, options.config.home);
  for (const extra of options.extraAdapters ?? []) {
    if (!registry.get(extra.id)) registry.register(extra);
  }
  const adapters = new Map<string, SourceAdapter>();
  for (const id of registry.list()) {
    const adapter = registry.get(id);
    if (!adapter) continue;
    if (adapter.scope.kind !== 'project' || adapter.scope.id !== engine.scopeId) {
      throw new Error(`Daemon adapter ${id} is outside the active project authority.`);
    }
    adapters.set(id, adapter);
    const result = await registry.sync(async () => engine, id, options.signal, engine.projection);
    totals.queued += result.queued + enqueueDueReviews(engine, id, Date.now(), options.config.maxReviewAgeMs);
  }
  const processed = await processAvailable(engine, adapters, options.owner, {
    ...(options.analyzer ? { analyzer: options.analyzer } : {}),
    ...(options.block ? { block: options.block } : {}),
    maxAttempts: options.config.maxAttempts,
    maxInputChars: options.config.maxInputChars,
    budget: { maxCallsPerDay: options.config.maxCallsPerDay, maxTokensPerDay: options.config.maxTokensPerDay },
    globalBudget,
    leaseMs: options.config.leaseMs,
    deadlineMs: options.config.jobDeadlineMs,
  }, options.signal);
  for (const result of processed) {
    totals.processed += 1;
    totals.modelCalls += result.modelCalls;
    totals.embeddingCalls += result.embeddingCalls;
    totals.inputTokens += result.inputTokens;
    totals.outputTokens += result.outputTokens;
  }
};

export const runCycle = async (options: CycleOptions): Promise<CycleReport> => {
  const totals = { queued: 0, processed: 0, modelCalls: 0, embeddingCalls: 0, inputTokens: 0, outputTokens: 0 };
  const scoped = { n: 0, failed: 0 };
  const globalBudget = new GlobalBudgetLedger(options.config.home);
  const processOne = async (engine: MemoryEngine): Promise<void> => {
    try {
      await processProject(engine, options, totals, globalBudget);
      scoped.n += 1;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      scoped.failed += 1;
    }
  };
  try {
    if (options.engines) {
      for (const engine of options.engines) await processOne(engine);
    } else {
      for (const id of await discoverProjectIds(options.config.home)) {
        const engine = await MemoryEngine.forScope('project', id, options.owner, { home: options.config.home }).catch(() => undefined);
        if (!engine) { scoped.failed += 1; continue; }
        try { await processOne(engine); } finally { await engine.dispose().catch(() => undefined); }
      }
    }
  } finally {
    globalBudget.close();
  }
  return {
    scopes: scoped.n, queued: totals.queued, processed: totals.processed, modelCalls: totals.modelCalls,
    embeddingCalls: totals.embeddingCalls, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
    ...(scoped.failed ? { failedScopes: scoped.failed } : {}), ...(options.block ? { blocked: options.block.code } : {}),
  };
};

export const resolveAnalyzer = async (config: DaemonConfig): Promise<{ analyzer?: Analyzer; block?: CurationBlockError }> =>
  tryCreateSdkAnalyzer({
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    maxOutputChars: config.maxOutputChars,
  });

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(), ms);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error('aborted'));
  };
  if (signal?.aborted) {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('aborted'));
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});

export const runLoop = async (options: CycleOptions, once: boolean): Promise<CycleReport> => {
  const cycle = { last: { scopes: 0, queued: 0, processed: 0, modelCalls: 0, embeddingCalls: 0, inputTokens: 0, outputTokens: 0 } as CycleReport };
  const tick = async (): Promise<CycleReport> => {
    const resolved = options.analyzer || options.block
      ? { ...(options.analyzer ? { analyzer: options.analyzer } : {}), ...(options.block ? { block: options.block } : {}) }
      : await resolveAnalyzer(options.config);
    cycle.last = await runCycle({ ...options, ...resolved });
    return cycle.last;
  };
  if (once) return tick();
  const loop = async (): Promise<CycleReport> => {
    await tick();
    if (options.signal?.aborted) return cycle.last;
    await sleep(options.config.intervalMs, options.signal).catch(() => undefined);
    if (options.signal?.aborted) return cycle.last;
    return loop();
  };
  return loop();
};
