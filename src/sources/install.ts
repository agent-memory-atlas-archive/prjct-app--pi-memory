import type { MemoryEngine } from '../engine.ts';
import { prjctHomeFor } from '../workspace/project-identity.ts';
import { discoverTeams, teamMailboxRoot } from './discovery.ts';
import { prjctObservationSource, teamArtifactSource, teamJournalSource } from './presets.ts';
import type { RecordMapping } from './records.ts';
import type { AdapterScope, EngineResolver, SourceAdapter, SourceRegistry } from './registry.ts';
import type { SelectionRules } from './shape.ts';

/**
 * Everything a caller might want to bend is here rather than in the adapters:
 * where the homes are, what to keep, and how to read a record. Anything left
 * unset falls back to the published directory rule and the conventional field
 * names, so the common case needs no configuration and an unusual publisher
 * needs a mapping instead of a code change.
 */
export type SourceInstallOptions = Readonly<{
  home?: string;
  mailboxRoot?: string;
  observations?: SelectionRules;
  teamJournal?: SelectionRules;
  mappings?: Readonly<{ observations?: Partial<RecordMapping>; teamJournal?: Partial<RecordMapping>; teamArtifacts?: Partial<RecordMapping> }>;
  teams?: boolean;
  /** Extra adapters registered alongside the discovered ones. */
  extra?: readonly SourceAdapter[];
}>;

export const registerKnownSources = async (registry: SourceRegistry, projectId: string,
  options: SourceInstallOptions = {}): Promise<readonly string[]> => {
  const home = prjctHomeFor(options.home);
  const scope: AdapterScope = { kind: 'project', id: projectId };
  registry.register(prjctObservationSource({ home, scope,
    ...(options.observations ? { select: options.observations } : {}),
    ...(options.mappings?.observations ? { mapping: options.mappings.observations } : {}) }));
  if (options.teams === true) {
    const mailboxRoot = teamMailboxRoot(options.mailboxRoot);
    for (const team of await discoverTeams(home)) {
      const teamScope: AdapterScope = { kind: 'team', id: team.id };
      // A team with no name has no mailbox to read, but its artifact store is
      // still worth indexing.
      if (team.name) {
        registry.register(teamJournalSource({ mailboxRoot, teamName: team.name, scope: teamScope,
          ...(options.teamJournal ? { select: options.teamJournal } : {}),
          ...(options.mappings?.teamJournal ? { mapping: options.mappings.teamJournal } : {}) }));
      }
      registry.register(teamArtifactSource({ home, scope: teamScope,
        ...(options.mappings?.teamArtifacts ? { mapping: options.mappings.teamArtifacts } : {}) }));
    }
  }
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
