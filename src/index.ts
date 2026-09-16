import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { checkpointAndEnqueueLegacy } from './curation/migrate.ts';
import type { MemoryEngine } from './engine.ts';
import { installMemoryHooks } from './extension/hooks.ts';
import type { HandoffBudget } from './handoff/select.ts';
import { installMemoryTools } from './extension/tools.ts';
import { runGc } from './retention/gc.ts';
import { registerKnownSources, scopedEngines, type SourceInstallOptions } from './sources/install.ts';
import { SourceRegistry, type SourceSyncResult } from './sources/registry.ts';
import { dueAdapters, PI_SESSION_SYNC_POLICY, type SyncPolicy } from './sources/schedule.ts';
import { SESSION_ADAPTER_ID } from './sources/session-log.ts';
import { sha256 } from './workspace/project-identity.ts';

export type MemoryExtensionOptions = Readonly<{
  home?: string; recallThreshold?: number;
  /** Explicit bound for messages retained after a real model switch. */
  handoff?: HandoffBudget;
  /** Thresholds that make a source due; `{ enabled: false }` turns it off. */
  sync?: SyncPolicy;
  /** Optional publisher adapters. pi-session remains the only default source. */
  sources?: Omit<SourceInstallOptions, 'home'>;
}>;

const USAGE = 'Usage: /memory status | sources | sync [adapter] | index {json} | replay | rebuild | gc | checkpoint-wal | migrate-curated | checkpoint {json}';

/**
 * Scans publisher sources, records fingerprints and enqueues analysis jobs.
 * It does not copy raw source bodies into the memory journal. The standalone
 * daemon publishes curated knowledge. Every adapter must declare this project's
 * owner; team, shared and foreign-project routing is rejected.
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
    await registerKnownSources(registry, engine.scopeId, {
      ...options.sources,
      ...(options.home === undefined ? {} : { home: options.home }),
    });
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
    const due = ready.list().filter(adapter => dueAdapters(project.projection, [adapter], adapter === SESSION_ADAPTER_ID
      ? { ...PI_SESSION_SYNC_POLICY, enabled: options.sync?.enabled ?? true }
      : options.sync ?? {})[0]?.due);
    if (!due.length) return;
    running.now = true;
    const engines = scopedEngines(project.journal.sessionId, project, options.home === undefined ? {} : { home: options.home });
    try {
      for (const adapter of due) await ready.sync(engines.resolve, adapter, undefined, project.projection).catch(() => undefined);
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
    description: 'Inspect or maintain pi-memory: /memory status | sources | sync [adapter] | index {json} | replay | rebuild | gc | checkpoint-wal | migrate-curated | checkpoint {json}',
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
      if (action === 'index') {
        const raw = args.trim().slice('index'.length).trim();
        if (!raw) throw new Error('Usage: /memory index {"namespace":"project.docs","externalId":"id","text":"..."}');
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('/memory index requires a JSON object.');
        const row = parsed as { namespace?: unknown; externalId?: unknown; text?: unknown; title?: unknown; uri?: unknown; source?: unknown; kind?: unknown; metadata?: unknown };
        if (typeof row.namespace !== 'string' || typeof row.externalId !== 'string' || typeof row.text !== 'string' || !row.text.trim()) {
          throw new Error('/memory index requires namespace, externalId, and non-empty text strings.');
        }
        const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? Object.fromEntries(Object.entries(row.metadata).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])) : {};
        const indexed = await engine.index({ namespace: row.namespace, externalId: row.externalId, scopeId: engine.scopeId,
          scopeKind: engine.scopeKind, source: typeof row.source === 'string' ? row.source : 'operator-indexed',
          kind: typeof row.kind === 'string' ? row.kind : 'document', ...(typeof row.title === 'string' ? { title: row.title } : {}),
          text: row.text, ...(typeof row.uri === 'string' ? { uri: row.uri } : {}), version: sha256(row.text), contentHash: sha256(row.text),
          observedAt: new Date().toISOString(), trust: 'user', metadata });
        ctx.ui.notify(JSON.stringify(indexed, null, 2), 'info');
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
