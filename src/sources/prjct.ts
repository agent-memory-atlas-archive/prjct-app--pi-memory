import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceDocument } from '../contracts/documents.ts';
import { sha256 } from '../workspace/project-identity.ts';
import type { SourceAdapter } from './registry.ts';

type Observation = Readonly<{
  id: string;
  provenance?: string;
  summary?: string;
  recordedAt?: string;
  workId?: string;
  taskId?: string;
  supports?: readonly { id: string; contentHash: string }[];
  execution?: { toolName?: string; command?: string; outcome?: string; sourcePaths?: string[] };
}>;

const observationFiles = async (root: string): Promise<string[]> => {
  const days = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && /^\d{8}$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name));
  const paths = await Promise.all(days.map(async day => {
    const dayPath = join(root, day.name);
    const sessions = (await readdir(dayPath, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory());
    return (await Promise.all(sessions.map(async session =>
      (await readdir(join(dayPath, session.name), { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => join(dayPath, session.name, entry.name))))).flat();
  }));
  return paths.flat();
};

const parseObservations = async (path: string): Promise<Observation[]> => {
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as { payload?: { observations?: Observation[] }; observations?: Observation[] };
    return record.payload?.observations ?? record.observations ?? [];
  } catch { return []; }
};

export class PrjctObservationAdapter implements SourceAdapter {
  readonly id = 'prjct-observations';
  private readonly home: string;
  private readonly projectId: string;
  constructor(home: string, projectId: string) { this.home = home; this.projectId = projectId; }

  async scan(signal?: AbortSignal): Promise<readonly SourceDocument[]> {
    const root = join(this.home, this.projectId, 'prjct', 'work', 'sessions');
    const files = await observationFiles(root);
    const groups = await Promise.all(files.map(async path => ({ path, observations: await parseObservations(path) })));
    return groups.flatMap(group => group.observations.flatMap(observation => {
      signal?.throwIfAborted();
      if (!observation.id || !observation.summary?.trim()) return [];
      const text = [observation.summary,
        observation.execution?.command ? `Command: ${observation.execution.command}` : '',
        observation.execution?.sourcePaths?.length ? `Paths: ${observation.execution.sourcePaths.join(', ')}` : ''].filter(Boolean).join('\n');
      const hash = sha256(text);
      return [{ namespace: 'prjct.observation', externalId: observation.id, scopeId: this.projectId, scopeKind: 'project' as const,
        source: 'prjct', kind: observation.execution?.outcome === 'failed' ? 'failure' : 'observation', text,
        uri: group.path, version: hash, contentHash: hash, observedAt: observation.recordedAt ?? new Date(0).toISOString(),
        trust: observation.provenance === 'native_observation' ? 'host' as const : 'agent' as const,
        metadata: { ...(observation.workId ? { workId: observation.workId } : {}), ...(observation.taskId ? { taskId: observation.taskId } : {}),
          ...(observation.execution?.toolName ? { tool: observation.execution.toolName } : {}) } }];
    }));
  }
}
