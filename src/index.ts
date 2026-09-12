import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { MemoryEngine } from './engine.ts';
import { installMemoryHooks } from './extension/hooks.ts';
import { installMemoryTools } from './extension/tools.ts';
import { runGc } from './retention/gc.ts';
import { registerKnownSources, scopedEngines } from './sources/install.ts';
import { SourceRegistry, type SourceSyncResult } from './sources/registry.ts';

export type MemoryExtensionOptions = Readonly<{ home?: string; mailboxRoot?: string; recallThreshold?: number }>;

const USAGE = 'Usage: /memory status | sources | sync [adapter] | replay | rebuild | gc';

/**
 * Pulls the siblings that publish into this machine's prjct home — the
 * project's own prjct observation stream and every team pi-team has registered
 * — into memory. Each adapter declares the scope it belongs to and is indexed
 * into that scope's engine, so team knowledge lands in the team's projection
 * rather than invisibly in the project's.
 */
const syncSources = async (registry: SourceRegistry, sessionId: string, project: MemoryEngine,
  target: string | undefined, options: MemoryExtensionOptions): Promise<SourceSyncResult[]> => {
  const engines = scopedEngines(sessionId, project, options.home === undefined ? {} : { home: options.home });
  try {
    return target ? [await registry.sync(engines.resolve, target)] : await registry.syncAll(engines.resolve);
  } finally {
    await engines.dispose();
  }
};

export const installMemory = (pi: ExtensionAPI, options: MemoryExtensionOptions = {}): void => {
  const runtime = installMemoryHooks(pi, {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.recallThreshold === undefined ? {} : { recallThreshold: options.recallThreshold }),
  });
  installMemoryTools(pi, runtime);
  const registry = new SourceRegistry();
  const registered = { done: false };

  const sources = async (engine: MemoryEngine): Promise<SourceRegistry> => {
    if (registered.done) return registry;
    registered.done = true;
    await registerKnownSources(registry, engine.scopeId, options);
    return registry;
  };

  pi.registerCommand('memory', {
    description: 'Inspect or maintain pi-memory: /memory status | sources | sync [adapter] | replay | rebuild | gc',
    handler: async (args, ctx) => {
      const engine = await runtime.engine();
      const [action = 'status', target] = args.trim().split(/\s+/).filter(Boolean);
      if (action === 'sources') {
        const list = (await sources(engine)).list();
        ctx.ui.notify(JSON.stringify({ scope: `${engine.scopeKind}/${engine.scopeId}`, adapters: list }, null, 2), 'info');
        return;
      }
      if (action === 'sync') {
        const registryReady = await sources(engine);
        if (target && !registryReady.get(target)) throw new Error(`Unknown source adapter: ${target}. Try /memory sources.`);
        const results = await syncSources(registryReady, ctx.sessionManager.getSessionId(), engine, target, options);
        ctx.ui.notify(JSON.stringify(results, null, 2), 'info');
        return;
      }
      const report = action === 'status' ? engine.projection.stats()
        : action === 'replay' ? await engine.replay(false)
        : action === 'rebuild' ? await engine.rebuild()
        : action === 'gc' ? await runGc(engine)
        : undefined;
      if (!report) throw new Error(USAGE);
      ctx.ui.notify(JSON.stringify(report, null, 2), 'info');
    },
  });
};

export default function memoryExtension(pi: ExtensionAPI): void {
  installMemory(pi);
}

export { hostEvidence, MemoryEngine } from './engine.ts';
