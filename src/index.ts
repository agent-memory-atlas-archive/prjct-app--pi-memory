import { existsSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
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
import { memoryDatabasePath, memoryHomeFor, resolveLegacyProject, sha256 } from './workspace/project-identity.ts';
import { resolveMemoryProject } from './workspace/memory-registry.ts';
import {
  errorModel, panelDismissed, presentMemoryPanel, resultModel, sourcesModel, statusModel, syncModel,
} from './extension/panel.ts';

export type MemoryExtensionOptions = Readonly<{
  home?: string; recallThreshold?: number;
  /** Explicit bound for messages retained after a real model switch. */
  handoff?: HandoffBudget;
  /** Thresholds that make a source due; `{ enabled: false }` turns it off. */
  sync?: SyncPolicy;
  /** Optional publisher adapters. pi-session remains the only default source. */
  sources?: Omit<SourceInstallOptions, 'home'>;
}>;

const USAGE = 'Usage: /memory init | status | sources | sync [adapter] | index {json} | replay | rebuild | gc | checkpoint-wal | migrate-curated | checkpoint {json}';
const ACTIONS = new Set(['init', 'status', 'sources', 'sync', 'index', 'replay', 'rebuild', 'gc', 'checkpoint-wal', 'migrate-curated', 'checkpoint']);
const ACTION_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: 'init', label: 'init', description: 'Initialize memory for this checkout' },
  { value: 'status', label: 'status', description: 'Show project memory status' },
  { value: 'sources', label: 'sources', description: 'Show source adapters and sync state' },
  { value: 'sync', label: 'sync', description: 'Scan all sources now, or choose an adapter' },
  { value: 'index', label: 'index', description: 'Index one JSON source document' },
  { value: 'checkpoint', label: 'checkpoint', description: 'Save an operational checkpoint from JSON' },
  { value: 'replay', label: 'replay', description: 'Replay durable memory history' },
  { value: 'rebuild', label: 'rebuild', description: 'Rebuild the searchable projection' },
  { value: 'gc', label: 'gc', description: 'Run bounded memory garbage collection' },
  { value: 'checkpoint-wal', label: 'checkpoint-wal', description: 'Checkpoint the SQLite write-ahead log' },
  { value: 'migrate-curated', label: 'migrate-curated', description: 'Queue legacy documents for curation' },
];

const argumentCompletions = (prefix: string, adapterIds: readonly string[]): AutocompleteItem[] | null => {
  const sync = /^sync\s+([^\s]*)$/u.exec(prefix);
  if (sync) {
    const adapterPrefix = sync[1] ?? '';
    const matching = adapterIds.filter(id => id.startsWith(adapterPrefix)).map(id => ({
      value: `sync ${id}`, label: `sync ${id}`, description: `Scan only the ${id} source`,
    }));
    return matching.length ? matching : null;
  }
  if (/\s/u.test(prefix)) return null;
  const matching = ACTION_COMPLETIONS.filter(item => item.value.startsWith(prefix));
  return matching.length ? [...matching] : null;
};

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
  const lastFault = { message: undefined as string | undefined };

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
      for (const adapter of due) {
        await ready.sync(engines.resolve, adapter, undefined, project.projection).catch(error => {
          lastFault.message = error instanceof Error ? error.message : String(error);
        });
      }
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

  const adapterIds = [...new Set([
    SESSION_ADAPTER_ID,
    ...(options.sources?.prjct ? ['prjct-observations'] : []),
    ...(options.sources?.extra ?? []).map(adapter => adapter.id),
  ].filter(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)))].sort();

  pi.registerCommand('memory', {
    description: 'Initialize, inspect or maintain pi-memory: /memory init | status | sources | sync [adapter] | index {json} | replay | rebuild | gc | checkpoint-wal | migrate-curated | checkpoint {json}',
    getArgumentCompletions: prefix => argumentCompletions(prefix, adapterIds),
    handler: async (args, ctx) => {
      const show = (model: Parameters<typeof presentMemoryPanel>[1]): Promise<void> => presentMemoryPanel(ctx, model);
      try {
      const [action = 'status', target] = args.trim().split(/\s+/).filter(Boolean);
      if (!ACTIONS.has(action)) throw new Error(USAGE);
      const home = memoryHomeFor(options.home);
      if (action === 'init') {
        if (target) throw new Error('Usage: /memory init');
        const initialized = await runtime.initialize();
        await show(resultModel('memory · init', [
          `status ${initialized.created ? 'initialized' : 'already initialized'}`,
          `project ${initialized.binding.projectId}`,
          `checkout ${initialized.binding.checkoutId}`,
          `source ${initialized.binding.source}`,
          `location ${initialized.binding.location}`,
        ]));
        return;
      }
      if (action === 'status') {
        const binding = await resolveMemoryProject(ctx.cwd, home);
        if (!binding) {
          const legacy = await resolveLegacyProject(ctx.cwd, home);
          await show(resultModel('memory · status', [
            'initialized no', 'ready no', `legacy ${legacy ? 'available' : 'none'}`, 'run /memory init',
          ]));
          return;
        }
        if (!existsSync(memoryDatabasePath(home, binding.projectId))) {
          await show(resultModel('memory · status', [
            'initialized yes', 'ready no', `project ${binding.projectId}`, 'run /memory init to repair',
          ]));
          return;
        }
        const opened = await runtime.engine();
        await show(statusModel({
          scope: `${opened.scopeKind}/${opened.scopeId}`, stats: opened.projection.stats(), curation: opened.curation.stats(),
          ...(lastFault.message ? { error: lastFault.message } : {}),
        }));
        return;
      }
      const engine = await runtime.engine();
      const scope = `${engine.scopeKind}/${engine.scopeId}`;
      if (action === 'sources') {
        const ready = await sources(engine);
        await show(sourcesModel({
          scope,
          adapters: ready.list().map(adapter => ({
            ...dueAdapters(engine.projection, [adapter], adapter === SESSION_ADAPTER_ID
              ? { ...PI_SESSION_SYNC_POLICY, enabled: options.sync?.enabled ?? true }
              : options.sync ?? {})[0]!,
            last: engine.projection.syncState(adapter) ?? null,
          })),
          ...(lastFault.message ? { error: lastFault.message } : {}),
        }));
        return;
      }
      if (action === 'sync') {
        const registryReady = await sources(engine);
        if (target && !registryReady.get(target)) throw new Error(`Unknown source adapter: ${target}. Try /memory sources.`);
        const results = await syncSources(registryReady, ctx.sessionManager.getSessionId(), engine, target, options);
        await show(syncModel(results, lastFault.message));
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
        await show(resultModel('memory · index', [`chunks ${indexed.chunks}`, `dense ${String(indexed.dense)}`]));
        return;
      }
      if (action === 'migrate-curated') {
        const migrated = await checkpointAndEnqueueLegacy(engine);
        await show(resultModel('memory · migrate', Object.entries(migrated).filter(([, value]) =>
          value === null || ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 8).map(([key, value]) => `${key} ${String(value)}`)));
        return;
      }
      if (action === 'checkpoint') {
        const raw = args.trim().slice('checkpoint'.length).trim();
        if (!raw) throw new Error('Usage: /memory checkpoint {"goal":"...","constraints":[],"done":[],"inProgress":[],"blocked":[],"decisions":[],"evidenceRefs":[],"nextSteps":[]}');
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || typeof (parsed as { goal?: unknown }).goal !== 'string' || !(parsed as { goal: string }).goal.trim()) {
          throw new Error('/memory checkpoint requires a non-empty goal.');
        }
        const saved = await runtime.handoff.persist(engine, ctx.sessionManager.getSessionId(),
          parsed as Parameters<typeof runtime.handoff.persist>[2]);
        await show(resultModel('memory · checkpoint', [`ok ${String(Boolean(saved))}`]));
        return;
      }
      const report = action === 'replay' ? await engine.replay(false)
        : action === 'rebuild' ? await engine.rebuild()
        : action === 'gc' ? await runGc(engine)
        : action === 'checkpoint-wal' ? engine.projection.checkpointWal()
        : undefined;
      if (report === undefined) throw new Error(USAGE);
      await show(resultModel(`memory · ${action}`, typeof report === 'object' && report
        ? Object.entries(report).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
          .slice(0, 8).map(([key, value]) => `${key} ${String(value)}`)
        : [String(report)]));
      } catch (error) {
        if (panelDismissed(error)) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('Usage:')) lastFault.message = message;
        await presentMemoryPanel(ctx, errorModel(message)).catch(() => undefined);
        throw error;
      }
    },
  });
};

export default function memoryExtension(pi: ExtensionAPI): void {
  installMemory(pi);
}

export { hostEvidence, MemoryEngine } from './engine.ts';
