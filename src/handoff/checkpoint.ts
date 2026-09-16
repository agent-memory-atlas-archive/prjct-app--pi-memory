import type { MemoryEngine } from '../engine.ts';
import { redactSecrets } from '../security/redact.ts';

export const CHECKPOINT_MAX_BYTES = 4_000;

export type OperationalCheckpoint = Readonly<{
  projectId: string;
  sessionId: string;
  goal: string;
  constraints: readonly string[];
  done: readonly string[];
  inProgress: readonly string[];
  blocked: readonly string[];
  decisions: readonly string[];
  evidenceRefs: readonly string[];
  nextSteps: readonly string[];
  updatedAt: string;
}>;

export const assertCheckpoint = (value: unknown): OperationalCheckpoint => {
  if (!value || typeof value !== 'object') throw new Error('Checkpoint must be an object.');
  const row = value as Record<string, unknown>;
  const text = (input: unknown): string => typeof input === 'string' ? redactSecrets(input.trim()) : '';
  const list = (input: unknown): string[] => Array.isArray(input) ? input.map(text).filter(Boolean).slice(0, 16) : [];
  const checkpoint: OperationalCheckpoint = {
    projectId: text(row.projectId),
    sessionId: text(row.sessionId),
    goal: text(row.goal),
    constraints: list(row.constraints),
    done: list(row.done),
    inProgress: list(row.inProgress),
    blocked: list(row.blocked),
    decisions: list(row.decisions),
    evidenceRefs: list(row.evidenceRefs),
    nextSteps: list(row.nextSteps),
    updatedAt: text(row.updatedAt) || new Date().toISOString(),
  };
  if (!checkpoint.projectId || !checkpoint.sessionId) throw new Error('Checkpoint requires projectId and sessionId.');
  if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > CHECKPOINT_MAX_BYTES) {
    throw new Error(`Checkpoint exceeds ${CHECKPOINT_MAX_BYTES} bytes.`);
  }
  return checkpoint;
};

export const readCheckpoint = (engine: MemoryEngine, sessionId: string): OperationalCheckpoint | undefined => {
  try {
    const body = engine.projection.operationalCheckpoint(engine.scopeId, sessionId);
    if (body === undefined) return undefined;
    const checkpoint = assertCheckpoint(JSON.parse(body));
    return checkpoint.projectId === engine.scopeId && checkpoint.sessionId === sessionId ? checkpoint : undefined;
  } catch {
    return undefined;
  }
};

export const writeCheckpoint = async (engine: MemoryEngine, checkpoint: OperationalCheckpoint): Promise<OperationalCheckpoint> => {
  const verified = assertCheckpoint(checkpoint);
  if (verified.projectId !== engine.scopeId) throw new Error('Checkpoint projectId does not match the open memory.');
  const updatedAt = Date.parse(verified.updatedAt);
  if (!Number.isFinite(updatedAt)) throw new Error('Checkpoint updatedAt must be ISO-8601.');
  const accepted = engine.projection.upsertOperationalCheckpoint(engine.scopeId, verified.sessionId, JSON.stringify(verified), updatedAt);
  if (!accepted) throw new Error('Checkpoint is stale; a newer updatedAt is already stored.');
  return verified;
};

export const renderCheckpoint = (checkpoint: OperationalCheckpoint): string =>
  [
    `Goal: ${checkpoint.goal}`,
    checkpoint.constraints.length ? `Constraints: ${checkpoint.constraints.join('; ')}` : '',
    checkpoint.done.length ? `Done: ${checkpoint.done.join('; ')}` : '',
    checkpoint.inProgress.length ? `In progress: ${checkpoint.inProgress.join('; ')}` : '',
    checkpoint.blocked.length ? `Blocked: ${checkpoint.blocked.join('; ')}` : '',
    checkpoint.decisions.length ? `Decisions: ${checkpoint.decisions.join('; ')}` : '',
    checkpoint.evidenceRefs.length ? `Evidence: ${checkpoint.evidenceRefs.join(', ')}` : '',
    checkpoint.nextSteps.length ? `Next: ${checkpoint.nextSteps.join('; ')}` : '',
  ].filter(Boolean).join('\n');
