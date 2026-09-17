import { appendFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from '../security/redact.ts';
import {
  assertProjectId, assertProjectLocalPath, memoryHomeFor, scopeRoot, sha256,
} from '../workspace/project-identity.ts';

export const SESSION_ADAPTER_ID = 'pi-session';
const MAX_SUMMARY_CHARS = 1_500;
const MAX_TURN_OBSERVATIONS = 64;
const REMEMBER = /(?:\bremember(?:\s+(?:that|to))?\b|\brecuerda(?:\s+que)?\b|\bacuérdate(?:\s+de)?\b)/iu;
const LEARNABLE = /(?:\b(always|never|don't|do not|prefer|instead|wrong|incorrect|use \S+ not|nunca|no uses?|en vez de|incorrect[oa]|prefier[eo])\b|\bremember(?:\s+(?:that|to))?\b|\brecuerda(?:\s+que)?\b|\bacuérdate(?:\s+de)?\b)/iu;
const CORRECTION = /\b(never|don't|do not|instead|wrong|incorrect|use \S+ not|prefer|nunca|no uses?|en vez de|incorrect[oa]|prefier[eo])\b/iu;
const ROUTINE_FAILURE = /(?:missing script|module not found|cannot find module|command not found|no such file|unknown command|process failed)\b/iu;
const REUSABLE_FAILURE = /\b(?:because|caused by|race|deadlock|stale|invalidat|overflow|leak|corrupt|timeout|permission|auth|lock|cache key|regression)\b/iu;
const DIAGNOSTIC_FAILURE = /(?:error TS\d+|TypeError|AssertionError|not ok\b|EACCES|EPERM|ENOENT|SQLITE_|FAIL:)/u;

export type SessionObservation = Readonly<{
  id: string;
  kind: 'failure' | 'instruction' | 'correction';
  tool: string;
  outcome: 'failed' | 'stated';
  summary: string;
  observedAt: string;
  provenance: 'native_observation' | 'declared';
  sessionId: string;
  /** Stable meaning and exact redacted text identity. Added at the write boundary. */
  semanticKey?: string;
  summaryHash?: string;
  capture?: 'auto-derived' | 'declared';
}>;

export const sessionLogRoot = (projectId: string, home?: string): string => {
  const owner = scopeRoot(memoryHomeFor(home), 'project', assertProjectId(projectId));
  return join(owner, 'pi-session');
};

/** Reject a symlinked pi-session root that resolves into another p_* authority. */
export const assertSessionLogIsolation = async (projectId: string, home?: string): Promise<string> => {
  const owner = scopeRoot(memoryHomeFor(home), 'project', assertProjectId(projectId));
  const root = join(owner, 'pi-session');
  const ownerInfo = await lstat(owner).catch(() => undefined);
  const info = await lstat(root).catch(() => undefined);
  if (ownerInfo?.isSymbolicLink() || info?.isSymbolicLink()) throw new Error('pi-session source cannot be a symbolic link.');
  if (info) assertProjectLocalPath(owner, root);
  return root;
};

export const clipSessionSummary = (text: string): string => {
  const redacted = redactSecrets(text).replaceAll(/\s+/gu, ' ').trim();
  return redacted.length <= MAX_SUMMARY_CHARS ? redacted : `${redacted.slice(0, MAX_SUMMARY_CHARS)}…`;
};

const contentWords = (text: string): readonly string[] =>
  text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]{2,}/gu) ?? [];

/** Auto-derived failures need reusable diagnosis, not merely an error-shaped line. */
export const sessionObservationWorthy = (input: Readonly<{
  kind: SessionObservation['kind'];
  tool: string;
  summary: string;
  outcome: SessionObservation['outcome'];
}>): boolean => {
  if (input.tool === 'memory_context' || input.tool === 'memory_record') return false;
  const summary = clipSessionSummary(input.summary);
  if (summary.length < 12) return false;
  if (input.kind === 'correction') return LEARNABLE.test(summary);
  if (input.kind === 'instruction') return input.tool === 'user_input' && LEARNABLE.test(summary);
  if (input.outcome !== 'failed' && input.kind !== 'failure') return false;
  const diagnostic = DIAGNOSTIC_FAILURE.test(summary) || REUSABLE_FAILURE.test(summary);
  if (ROUTINE_FAILURE.test(summary) && !diagnostic) return false;
  return summary.length >= 40 && contentWords(summary).length >= 6 && diagnostic;
};

/** Strip the host wrapper so capture/recall see the diagnosis, not "bash failed". */
export const sessionFailureStatement = (summary: string): string => {
  const clipped = clipSessionSummary(summary);
  const stripped = clipped.replace(/^\S+\s+failed(?:\s+|>\s*)/iu, '').trim();
  return stripped.length >= 12 ? stripped : clipped;
};

const normalizedMeaning = (summary: string): string => clipSessionSummary(summary).toLocaleLowerCase()
  .replaceAll(/\b[0-9a-f]{8,}\b/giu, '<id>')
  .replaceAll(/\b\d+(?:\.\d+)?\b/gu, '<n>')
  .replaceAll(/\s+/gu, ' ').trim();

export const sessionObservationIdentity = (kind: SessionObservation['kind'], tool: string, summary: string): Readonly<{
  semanticKey: string; summaryHash: string;
}> => {
  const clipped = clipSessionSummary(summary);
  return {
    semanticKey: `pi-session.${kind}.${tool}.${sha256(normalizedMeaning(clipped)).slice(0, 20)}`,
    summaryHash: sha256(clipped),
  };
};

export const sessionObservationId = (_sessionId: string, tool: string, summary: string,
  kind: SessionObservation['kind'] = tool === 'user_input' ? 'instruction' : 'failure'): string => {
  const identity = sessionObservationIdentity(kind, tool, summary);
  return `obs_${sha256(`${identity.semanticKey}\u0000${identity.summaryHash}`).slice(0, 20)}`;
};

const preparedObservation = (input: SessionObservation): SessionObservation => {
  const summary = clipSessionSummary(input.summary);
  if (input.tool === 'user_input' && input.provenance !== 'declared') {
    throw new Error('User prompts require declared provenance.');
  }
  if (input.tool !== 'user_input' && input.provenance !== 'native_observation') {
    throw new Error('Tool failures require host-native provenance.');
  }
  const identity = sessionObservationIdentity(input.kind, input.tool, summary);
  return {
    ...input,
    id: `obs_${sha256(`${identity.semanticKey}\u0000${identity.summaryHash}`).slice(0, 20)}`,
    summary,
    ...identity,
    capture: input.provenance === 'declared' ? 'declared' : 'auto-derived',
  };
};

/** One append per UTC day for a whole turn. Duplicate meaning/text pairs collapse before I/O. */
export const appendSessionObservations = async (options: Readonly<{
  projectId: string;
  home?: string;
  records: readonly SessionObservation[];
}>): Promise<number> => {
  const unique = [...new Map(options.records.slice(0, MAX_TURN_OBSERVATIONS).map(record => {
    const prepared = preparedObservation(record);
    return [`${prepared.semanticKey}\u0000${prepared.summaryHash}`, prepared] as const;
  })).values()].filter(sessionObservationWorthy);
  if (!unique.length) return 0;
  const root = sessionLogRoot(options.projectId, options.home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertSessionLogIsolation(options.projectId, options.home);
  const byDay = unique.reduce<Map<string, SessionObservation[]>>((groups, record) => {
    const day = record.observedAt.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), record]);
    return groups;
  }, new Map());
  for (const [day, records] of byDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error('Session observation requires an ISO date.');
    const path = assertProjectLocalPath(root, join(root, `${day}.jsonl`));
    await appendFile(path, records.map(record => `${JSON.stringify(record)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
  }
  return unique.length;
};

export const appendSessionObservation = async (options: Readonly<{
  projectId: string;
  home?: string;
  record: SessionObservation;
}>): Promise<boolean> => (await appendSessionObservations({ ...options, records: [options.record] })) === 1;

const declaredQuote = (prompt: string, marker: RegExp): string | undefined => {
  if (!marker.test(prompt)) return undefined;
  const candidates = prompt.split(/(?<=[.!?])\s+|\n+/u).map(value => value.trim()).filter(Boolean);
  const selected = candidates.find(value => marker.test(value)) ?? prompt.trim();
  if (selected.length < 12 || selected.length > 500 || contentWords(selected).length < 3) return undefined;
  if (redactSecrets(selected) !== selected) return undefined;
  return prompt.includes(selected) ? selected : undefined;
};

/** Return a bounded exact substring; it can therefore be used as declared evidence. */
export const declaredCorrectionQuote = (prompt: string): string | undefined => declaredQuote(prompt, CORRECTION);

/** Exact explicit remember/recuerda declarations become durable without waiting for daemon analysis. */
export const declaredMemoryQuote = (prompt: string): string | undefined => {
  const quote = declaredQuote(prompt, REMEMBER);
  if (!quote || /[?¿]/u.test(quote) || /\b(?:don't|do not|no)\s+remember\b/iu.test(quote)) return undefined;
  return quote;
};
