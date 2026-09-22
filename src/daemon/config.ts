import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryHomeFor } from '../workspace/project-identity.ts';

export type DaemonConfig = Readonly<{
  home: string;
  provider?: string;
  model?: string;
  intervalMs: number;
  maxReviewAgeMs: number;
  jobDeadlineMs: number;
  maxAttempts: number;
  maxCallsPerDay: number;
  maxTokensPerDay: number;
  maxInputChars: number;
  maxOutputChars: number;
  leaseMs: number;
  /**
   * The maintenance pass rewrites the standing of facts already stored, so it
   * stays off until a project asks for it: `"analysis": {"maintenance": true}`
   * in the shared config, or PI_MEMORY_DAEMON_MAINTENANCE=1.
   */
  maintenance: boolean;
  /** Set by a session-close run: curate only this project, learning from this session. */
  projectId?: string;
  sessionFile?: string;
}>;

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

export const loadDaemonConfig = async (overrides: Partial<DaemonConfig> = {}): Promise<DaemonConfig> => {
  const home = overrides.home ?? process.env.PI_MEMORY_DAEMON_HOME ?? memoryHomeFor();
  const shared = join(home, 'shared', 'memory', 'config.json');
  const raw = await readFile(shared, 'utf8').catch(() => undefined);
  const parsed = raw ? JSON.parse(raw) as { analysis?: Partial<DaemonConfig> } : {};
  const analysis = parsed.analysis ?? {};
  const flag = process.env.PI_MEMORY_DAEMON_MAINTENANCE;
  return {
    home,
    maintenance: overrides.maintenance ?? (flag === '1' ? true : flag === '0' ? false : analysis.maintenance === true),
    intervalMs: overrides.intervalMs ?? integer(process.env.PI_MEMORY_DAEMON_INTERVAL_MS, analysis.intervalMs ?? 5 * 60_000),
    maxReviewAgeMs: overrides.maxReviewAgeMs ?? integer(process.env.PI_MEMORY_DAEMON_REVIEW_AGE_MS, analysis.maxReviewAgeMs ?? 30 * 86_400_000),
    jobDeadlineMs: overrides.jobDeadlineMs ?? integer(process.env.PI_MEMORY_DAEMON_DEADLINE_MS, analysis.jobDeadlineMs ?? 120_000),
    maxAttempts: overrides.maxAttempts ?? integer(process.env.PI_MEMORY_DAEMON_MAX_ATTEMPTS, analysis.maxAttempts ?? 5),
    maxCallsPerDay: overrides.maxCallsPerDay ?? integer(process.env.PI_MEMORY_DAEMON_MAX_CALLS, analysis.maxCallsPerDay ?? 200),
    maxTokensPerDay: overrides.maxTokensPerDay ?? integer(process.env.PI_MEMORY_DAEMON_MAX_TOKENS, analysis.maxTokensPerDay ?? 500_000),
    maxInputChars: overrides.maxInputChars ?? integer(process.env.PI_MEMORY_DAEMON_MAX_INPUT, analysis.maxInputChars ?? 24_000),
    maxOutputChars: overrides.maxOutputChars ?? integer(process.env.PI_MEMORY_DAEMON_MAX_OUTPUT, analysis.maxOutputChars ?? 12_000),
    leaseMs: overrides.leaseMs ?? integer(process.env.PI_MEMORY_DAEMON_LEASE_MS, analysis.leaseMs ?? 60_000),
    provider: overrides.provider ?? process.env.PI_MEMORY_ANALYSIS_PROVIDER ?? analysis.provider,
    model: overrides.model ?? process.env.PI_MEMORY_ANALYSIS_MODEL ?? analysis.model,
    ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
    ...(overrides.sessionFile ? { sessionFile: overrides.sessionFile } : {}),
  };
};

export const daemonStateDir = (home: string): string => join(home, 'shared', 'memory', 'daemon');
export const daemonPidPath = (home: string): string => join(daemonStateDir(home), 'pi-memory.pid');
export const daemonAlivePath = (home: string): string => join(daemonStateDir(home), 'pi-memory.alive');
export const daemonLogPath = (home: string): string => join(daemonStateDir(home), 'pi-memory.log');
