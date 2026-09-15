import { cp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryEngine } from '../engine.ts';
import { MEMORY_DATABASE } from '../workspace/project-identity.ts';
import { withSourceIdentity } from '../sources/identity.ts';
import { identityFromDocument, jobIdFor } from './store.ts';
import { isCuratedNamespace } from './types.ts';

export type MigrationReport = Readonly<{
  checkpoint: string;
  enqueued: number;
  skippedCurated: number;
  rawJournalPreserved: true;
  limitation: string;
}>;

/**
 * Consistent SQLite snapshots plus a journal copy, then enqueue existing raw
 * documents for analysis. Fail closed: a partial copy is not a checkpoint.
 * Never deletes publisher sources or journal history.
 */
export const checkpointAndEnqueueLegacy = async (engine: MemoryEngine, at = new Date()): Promise<MigrationReport> => {
  const stamp = at.toISOString().replaceAll(':', '').replaceAll('.', '');
  const checkpoint = join(engine.root, `checkpoint-raw-${stamp}`);
  await mkdir(checkpoint, { recursive: true, mode: 0o700 });
  const events = join(engine.root, 'events');
  try {
    if (await stat(events).catch(() => undefined)) {
      await cp(events, join(checkpoint, 'events'), { recursive: true });
    }
    engine.projection.exportSnapshot(join(checkpoint, MEMORY_DATABASE));
  } catch (error) {
    await rm(checkpoint, { recursive: true, force: true });
    throw error;
  }
  const counts = { enqueued: 0, skipped: 0 };
  engine.curation.transaction(() => {
    for (const document of engine.projection.eachActiveDocument()) {
      if (isCuratedNamespace(document.namespace)) {
        counts.skipped += 1;
        continue;
      }
      const adapter = document.sync?.adapter ?? 'legacy-journal';
      const prepared = document.sync ? document : withSourceIdentity(adapter, document);
      const identity = identityFromDocument(adapter, prepared);
      engine.curation.upsertFingerprint(identity);
      engine.curation.enqueue({
        id: jobIdFor(engine.scopeId, 'analyze', identity.documentKey, identity.revision),
        scopeId: engine.scopeId, adapter, documentKey: identity.documentKey,
        action: 'analyze', inputRevision: identity.revision, contentHash: identity.contentHash,
      });
      counts.enqueued += 1;
    }
  });
  const report: MigrationReport = {
    checkpoint, enqueued: counts.enqueued, skippedCurated: counts.skipped, rawJournalPreserved: true,
    limitation: 'Historical document.upserted events still contain raw source bodies. This checkpoint is one VACUUM INTO of the project memory.sqlite plus a journal copy; it is reversible by leaving the live database untouched. It does not rewrite or delete events. Projection rows remain until an explicit later compact. Publisher-owned sources are never deleted. Legacy bodies are readable through the legacy-journal adapter for analysis only; interactive recall defaults to curated namespaces.',
  };
  await writeFile(join(checkpoint, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
};
