import type { MemoryEngine } from '../engine.ts';
import { memoryHomeFor } from '../workspace/project-identity.ts';
import { piSessionDigestSource } from './session-digest.ts';
import { piSessionSource } from './presets.ts';
import { prjctObservationSource } from './prjct.ts';
import type { RecordMapping } from './records.ts';
import type { AdapterScope, EngineResolver, SourceAdapter, SourceRegistry } from './registry.ts';
import type { SelectionRules } from './shape.ts';

/** Configuration for the optional prjct compatibility adapter. */
export type PrjctObservationOptions = Readonly<{
  /** Override the publisher home without changing pi-memory's own home. */
  home?: string;
  select?: SelectionRules;
  mapping?: Partial<RecordMapping>;
}>;

/**
 * pi-session is the only first-party source. Other publishers are explicit
 * adapters: their absence must not alter pi-memory startup or maintenance.
 */
export type SourceInstallOptions = Readonly<{
  home?: string;
  /** Opt in to records published by prjct; omitted means its observation tree is never scanned. */
  prjct?: PrjctObservationOptions;
  /** Extra adapters registered alongside pi-memory's own session source. */
  extra?: readonly SourceAdapter[];
  /**
   * How much of a session the analyser sees at once. `digest` hands it the
   * whole settled session, which is where the relation between what was tried
   * and what it means for the repository lives. `observation` restores the
   * per-record adapter, which can only ever restate one tool failure.
   */
  sessionGranularity?: 'digest' | 'observation' | 'both';
  /** How long a session must be idle before its digest is analysed. */
  sessionSettleMs?: number;
}>;

export const registerKnownSources = async (registry: SourceRegistry, projectId: string,
  options: SourceInstallOptions = {}): Promise<readonly string[]> => {
  const home = memoryHomeFor(options.home);
  const scope: AdapterScope = { kind: 'project', id: projectId };
  // Medido sobre 85 observaciones reales: por observacion costo $1,54 y produjo
  // 67 topics, un tercio de ellos reformulando que una ruta no existia. Por
  // sesion costo $0,30 y produjo 9 hechos utilizables y ningun ruido. El
  // adaptador por observacion sigue disponible, pero ya no es el de partida.
  const granularity = options.sessionGranularity ?? 'digest';
  if (granularity !== 'digest') registry.register(piSessionSource({ home, scope }));
  if (granularity !== 'observation') registry.register(piSessionDigestSource({ home, scope,
    ...(options.sessionSettleMs === undefined ? {} : { settleMs: options.sessionSettleMs }) }));
  if (options.prjct) registry.register(prjctObservationSource({
    home: options.prjct.home ?? home,
    scope,
    ...(options.prjct.select ? { select: options.prjct.select } : {}),
    ...(options.prjct.mapping ? { mapping: options.prjct.mapping } : {}),
  }));
  for (const adapter of options.extra ?? []) registry.register(adapter);
  return registry.list();
};

/**
 * Opens one engine per scope and keeps it, so syncing several adapters does not
 * reopen the same SQLite projection. The project engine is supplied by the
 * caller because the session already owns one.
 */
export const scopedEngines = (sessionId: string, project: MemoryEngine, options: { home?: string } = {}): {
  resolve: EngineResolver; dispose(): Promise<void>;
} => {
  const cache = new Map<string, Promise<MemoryEngine>>();
  const key = (scope: AdapterScope): string => `${scope.kind}:${scope.id}`;
  const resolve: EngineResolver = async scope => {
    if (scope.kind !== 'project' || scope.id !== project.scopeId) {
      throw new Error(`Source scope ${scope.kind}/${scope.id} is not this project's memory.`);
    }
    if (scope.kind === project.scopeKind && scope.id === project.scopeId) return project;
    const existing = cache.get(key(scope));
    if (existing) return existing;
    throw new Error(`Source scope ${scope.kind}/${scope.id} is not this project's memory.`);
  };
  return {
    resolve,
    // Only the engines this helper opened; the caller's project engine outlives
    // the sync and is not ours to close.
    dispose: async () => {
      for (const pending of cache.values()) await pending.then(engine => engine.dispose()).catch(() => undefined);
      cache.clear();
    },
  };
};
