import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { checkpointAndEnqueueLegacy } from './curation/migrate.ts';
import type { MemoryEngine } from './engine.ts';
import { installMemoryHooks } from './extension/hooks.ts';
import type { HandoffBudget } from './handoff/select.ts';
import { installMemoryTools } from './extension/tools.ts';
import { runGc } from './retention/gc.ts';
import { registerKnownSources, scopedEngines } from './sources/install.ts';
import { SourceRegistry, type SourceSyncResult } from './sources/registry.ts';
import { dueAdapters, type SyncPolicy } from './sources/schedule.ts';

export type MemoryExtensionOptions = Readonly<{
  home?: string; mailboxRoot?: string; recallThreshold?: number;
  /** Explicit bound for messages retained after a real model switch. */
  handoff?: HandoffBudget;
  /** Thresholds that make a source due; `{ enabled: false }` turns it off. */
  sync?: SyncPolicy;
}>;

const USAGE = 'Usage: /memory status | sources | sync [adapter] | replay | rebuild | gc | checkpoint-wal | migrate-curated | checkpoint {json}';

/**
 * Scans publisher sources, records fingerprints and enqueues analysis jobs.
 * It does not copy raw source bodies into the memory journal. The standalone
 * daemon publishes curated knowledge. Each adapter is routed to the scope it
 * declares.
 */
const syncSources = async (registry: SourceRegistry, sessionId: string, project: MemoryEngine,
  target: string | undefined, options: MemoryExtensionOptions): Promise<SourceSyncResult[]> => {
  const engines = scopedEngines(sessionId, project, options.home === undefined ? {} : { home: options.home });
  try {
    // An explicit /memory sync always runs, whatever the watermarks say.
    return target
      ? [await registry.sync(engines.resolve, target, undefined, project.projection)]
      : await registry.syncAll(engines.resolve, undefined, project.projection);
  } finally {
    await engines.dispose();
  }
};

export const installMemory = (pi: ExtensionAPI, options: MemoryExtensionOptions = {}): void => {
  const registry = new SourceRegistry();
  const registered = { done: false };
  const running = { now: false };

  const sources = async (engine: MemoryEngine): Promise<SourceRegistry> => {
    if (registered.done) return registry;
    registered.done = true;
    await registerKnownSources(registry, engine.scopeId, options);
    return registry;
  };

  /**
   * Sync is not automatic in the sense of running on a schedule or at every
   * start. Each turn adds to a watermark table, and only when work since the
   * last run crosses a threshold does a source get re-read — in the background,
   * so the turn is never waiting on it, and never twice at once.
   */
  const syncIfDue = async (project: MemoryEngine): Promise<void> => {
    if (options.sync?.enabled === false || running.now) return;
    const ready = await sources(project);
    if (!dueAdapters(project.projection, ready.list(), options.sync ?? {}).some(decision => decision.due)) return;
    running.now = true;
    const engines = scopedEngines(project.journal.sessionId, project, options.home === undefined ? {} : { home: options.home });
    try {
      await ready.syncDue(engines.resolve, project.projection, options.sync ?? {});
    } finally {
      await engines.dispose().catch(() => undefined);
      running.now = false;
    }
  };

  const runtime = installMemoryHooks(pi, {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.recallThreshold === undefined ? {} : { recallThreshold: options.recallThreshold }),
    ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
    // Deliberately not awaited by the hook: a source scan must never sit
    // between the user's prompt and the agent starting.
    onActivity: project => { void syncIfDue(project).catch(() => undefined); },
  });
  installMemoryTools(pi, runtime);

  pi.registerCommand('memory', {
    description: 'Inspect or maintain pi-memory: /memory status | sources | sync [adapter] | replay | rebuild | gc | checkpoint-wal | migrate-curated | checkpoint {json}',
    handler: async (args, ctx) => {
      try {
      const engine = await runtime.engine();
      const [action = 'status', target] = args.trim().split(/\s+/).filter(Boolean);
      if (action === 'sources') {
        const ready = await sources(engine);
        ctx.ui.notify(JSON.stringify({
          scope: `${engine.scopeKind}/${engine.scopeId}`,
          activity: engine.projection.activity(),
          curation: engine.curation.stats(),
          adapters: dueAdapters(engine.projection, ready.list(), options.sync ?? {}).map(decision => ({
            ...decision, last: engine.projection.syncState(decision.adapter) ?? null,
          })),
        }, null, 2), 'info');
        return;
      }
      if (action === 'sync') {
        const registryReady = await sources(engine);
        if (target && !registryReady.get(target)) throw new Error(`Unknown source adapter: ${target}. Try /memory sources.`);
        const results = await syncSources(registryReady, ctx.sessionManager.getSessionId(), engine, target, options);
        ctx.ui.notify(JSON.stringify(results, null, 2), 'info');
        return;
      }
      if (action === 'migrate-curated') {
        ctx.ui.notify(JSON.stringify(await checkpointAndEnqueueLegacy(engine), null, 2), 'info');
        return;
      }
      if (action === 'checkpoint') {
        const raw = args.trim().slice('checkpoint'.length).trim();
        if (!raw) throw new Error('Usage: /memory checkpoint {"goal":"...","constraints":[],"done":[],"inProgress":[],"blocked":[],"decisions":[],"evidenceRefs":[],"nextSteps":[]}');
        const saved = await runtime.handoff.persist(engine, ctx.sessionManager.getSessionId(), JSON.parse(raw));
        ctx.ui.notify(JSON.stringify(saved, null, 2), 'info');
        return;
      }
      const report = action === 'status' ? { ...engine.projection.stats(), curation: engine.curation.stats() }
        : action === 'replay' ? await engine.replay(false)
        : action === 'rebuild' ? await engine.rebuild()
        : action === 'gc' ? await runGc(engine)
        : action === 'checkpoint-wal' ? engine.projection.checkpointWal()
        : undefined;
      if (!report) throw new Error(USAGE);
      ctx.ui.notify(JSON.stringify(report, null, 2), 'info');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, 'error');
        throw error;
      }
    },
  });
};

export default function memoryExtension(pi: ExtensionAPI): void {
  installMemory(pi);
}

export { hostEvidence, MemoryEngine } from './engine.ts';
