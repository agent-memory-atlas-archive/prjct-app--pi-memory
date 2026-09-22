import type { MemoryEngine } from '../engine.ts';
import { documentKey } from '../contracts/documents.ts';
import { assessValue, type ValueAssessment } from './value.ts';

export type GcPlan = Readonly<{
  removeDocumentKeys: readonly string[];
  retainedDocumentKeys: readonly string[];
  assessments: readonly ValueAssessment[];
}>;

export const planGc = (engine: MemoryEngine, now = Date.now()): GcPlan => {
  const documents = [...engine.projection.eachActiveDocument()];
  const candidates = new Set(engine.projection.gcCandidates(now));
  const assessments = engine.projection.activeFacts(engine.scopeId).map(fact => assessValue(fact, now));
  const protectedIds = new Set(assessments.filter(item => item.protected && item.score >= 35).map(item => item.id));
  const protectedDocumentKeys = new Set(documents
    .filter(document => document.namespace === 'memory' && protectedIds.has(document.externalId))
    .map(documentKey));
  const removeDocumentKeys = [...candidates].filter(key => !protectedDocumentKeys.has(key));
  const removed = new Set(removeDocumentKeys);
  return { removeDocumentKeys, retainedDocumentKeys: documents.map(documentKey).filter(key => !removed.has(key)), assessments };
};

export const runGc = async (engine: MemoryEngine, now = Date.now()): Promise<{
  removed: number;
  retained: number;
  bytesBefore: number;
  bytesAfter: number;
}> => {
  const before = engine.projection.stats();
  const plan = planGc(engine, now);
  const batches = Array.from({ length: Math.ceil(plan.removeDocumentKeys.length / 64) }, (_, index) =>
    plan.removeDocumentKeys.slice(index * 64, (index + 1) * 64));
  for (const batch of batches) await engine.recordGc(batch, plan.retainedDocumentKeys.length);
  engine.projection.gcProjection(new Set(plan.retainedDocumentKeys), engine.vector.provider.model);
  // Facts deleted since the last pass leave the journal files here, in one rewrite.
  await engine.compactJournal().catch(() => undefined);
  const after = engine.projection.stats();
  return { removed: plan.removeDocumentKeys.length, retained: plan.retainedDocumentKeys.length,
    bytesBefore: before.bytes, bytesAfter: after.bytes };
};
