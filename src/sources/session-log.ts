import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from '../security/redact.ts';
import { assertProjectId, assertProjectLocalPath, prjctHomeFor, sha256 } from '../workspace/project-identity.ts';

export const SESSION_ADAPTER_ID = 'pi-session';
const MAX_SUMMARY_CHARS = 1_500;
const LEARNABLE = /\b(always|never|don't|do not|prefer|instead|wrong|incorrect|remember:|use \S+ not)\b/iu;

export type SessionObservation = Readonly<{
  id: string;
  kind: 'failure' | 'instruction' | 'correction';
  tool: string;
  outcome: 'failed' | 'stated';
  summary: string;
  observedAt: string;
  provenance: 'native_observation' | 'declared';
  sessionId: string;
}>;

export const sessionLogRoot = (projectId: string, home?: string): string =>
  join(prjctHomeFor(home), assertProjectId(projectId), 'pi-session');

export const clipSessionSummary = (text: string): string => {
  const redacted = redactSecrets(text).replaceAll(/\s+/gu, ' ').trim();
  return redacted.length <= MAX_SUMMARY_CHARS ? redacted : `${redacted.slice(0, MAX_SUMMARY_CHARS)}…`;
};

export const sessionObservationWorthy = (input: Readonly<{
  kind: SessionObservation['kind'];
  tool: string;
  summary: string;
  outcome: SessionObservation['outcome'];
}>): boolean => {
  if (input.tool === 'memory_context' || input.tool === 'memory_record') return false;
  if (input.summary.trim().length < 12) return false;
  if (input.outcome === 'failed' || input.kind === 'failure' || input.kind === 'correction') return true;
  return input.kind === 'instruction' && LEARNABLE.test(input.summary);
};

export const sessionObservationId = (sessionId: string, tool: string, summary: string): string =>
  `obs_${sha256(`${sessionId}:${tool}:${summary}`).slice(0, 16)}`;

export const appendSessionObservation = async (options: Readonly<{
  projectId: string;
  home?: string;
  record: SessionObservation;
}>): Promise<boolean> => {
  const summary = clipSessionSummary(options.record.summary);
  const record = { ...options.record, summary };
  if (!sessionObservationWorthy(record)) return false;
  const root = sessionLogRoot(options.projectId, options.home);
  await mkdir(root, { recursive: true });
  const day = record.observedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error('Session observation requires an ISO date.');
  const path = assertProjectLocalPath(root, join(root, `${day}.jsonl`));
  await appendFile(path, `${JSON.stringify(record)}\n`);
  return true;
};
