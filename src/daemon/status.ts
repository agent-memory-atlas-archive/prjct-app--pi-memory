import { readFile } from 'node:fs/promises';
import { daemonPidPath } from './config.ts';

export type DaemonPid = Readonly<{ pid: number; token: string; startedAt: string; home: string }>;

export const isRunning = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export const readPid = async (home: string): Promise<DaemonPid | undefined> => {
  const path = daemonPidPath(home);
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as DaemonPid;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

export const daemonStatus = async (home: string, probe = true): Promise<Readonly<{ running: boolean; pid?: number; startedAt?: string }>> => {
  const recorded = await readPid(home);
  if (!recorded) return { running: false };
  const running = probe ? isRunning(recorded.pid) : Boolean(recorded.pid);
  if (!running) return { running: false, pid: recorded.pid, startedAt: recorded.startedAt };
  return { running: true, pid: recorded.pid, startedAt: recorded.startedAt };
};
