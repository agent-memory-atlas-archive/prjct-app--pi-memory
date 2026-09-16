import type { MemoryEngine } from '../engine.ts';
import { memoryHomeFor } from '../workspace/project-identity.ts';
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
}>;

export const registerKnownSources = async (registry: SourceRegistry, projectId: string,
  options: SourceInstallOptions = {}): Promise<readonly string[]> => {
  const home = memoryHomeFor(options.home);
  const scope: AdapterScope = { kind: 'project', id: projectId };
  registry.register(piSessionSource({ home, scope }));
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
