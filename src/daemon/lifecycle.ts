import { spawn } from 'node:child_process';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { daemonAlivePath, daemonLogPath, daemonPidPath, daemonStateDir, type DaemonConfig } from './config.ts';
import { daemonStatus, isRunning, readPid, type DaemonPid } from './status.ts';

export { daemonStatus, readPid, type DaemonPid } from './status.ts';

type Alive = Readonly<{ pid: number; token: string }>;

const writePid = async (home: string, record: DaemonPid): Promise<void> => {
  mkdirSync(daemonStateDir(home), { recursive: true, mode: 0o700 });
  const path = daemonPidPath(home);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record), 'utf8'); } finally { await handle.close(); }
};

export const readAlive = async (home: string): Promise<Alive | undefined> => {
  const raw = await readFile(daemonAlivePath(home), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Alive;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

export const announceAlive = async (home: string, token: string, pid = process.pid): Promise<void> => {
  mkdirSync(daemonStateDir(home), { recursive: true, mode: 0o700 });
  await writeFile(daemonAlivePath(home), JSON.stringify({ pid, token }), { mode: 0o600 });
};

const ownsProcess = async (home: string, recorded: DaemonPid): Promise<boolean> => {
  const alive = await readAlive(home);
  return Boolean(alive && alive.pid === recorded.pid && alive.token === recorded.token && isRunning(recorded.pid));
};

export const stopDaemon = async (home: string, timeoutMs = 10_000): Promise<{ stopped: boolean; pid?: number }> => {
  const recorded = await readPid(home);
  if (!recorded) {
    await rm(daemonAlivePath(home), { force: true });
    return { stopped: true };
  }
  if (!(await ownsProcess(home, recorded))) {
    if (isRunning(recorded.pid)) return { stopped: false, pid: recorded.pid };
    await rm(daemonPidPath(home), { force: true });
    await rm(daemonAlivePath(home), { force: true });
    return { stopped: true, pid: recorded.pid };
  }
  process.kill(recorded.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  const wait = async (): Promise<void> => {
    if (!isRunning(recorded.pid) || Date.now() >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, 50));
    return wait();
  };
  await wait();
  if (isRunning(recorded.pid) && await ownsProcess(home, recorded)) process.kill(recorded.pid, 'SIGKILL');
  await rm(daemonPidPath(home), { force: true });
  await rm(daemonAlivePath(home), { force: true });
  return { stopped: true, pid: recorded.pid };
};

// The compiled local build (scripts/build-pi.mjs) ships memory-daemon.js; source runs keep the .ts entry.
// Source checkouts run from src/daemon; the Pi build bundles everything into
// its root index.js with scripts/ beside it.
const cliPath = (): string => {
  const candidates = import.meta.url.endsWith('.ts')
    ? ['../../scripts/memory-daemon.ts']
    : ['./scripts/memory-daemon.js', '../../scripts/memory-daemon.js'];
  const paths = candidates.map(relative => fileURLToPath(new URL(relative, import.meta.url)));
  return paths.find(path => existsSync(path)) ?? paths[0]!;
};

/**
 * One detached cycle with the session's model, started when a session closes.
 * It does nothing when a resident daemon owns the home or another run is still
 * going, and it never blocks the caller.
 */
export const spawnCurationRun = async (config: DaemonConfig, argv: readonly string[] = process.execArgv): Promise<number | undefined> => {
  if ((await daemonStatus(config.home)).running) return undefined;
  const lock = join(daemonStateDir(config.home), 'curation.pid');
  const held = Number(await readFile(lock, 'utf8').catch(() => ''));
  if (held && isRunning(held)) return undefined;
  mkdirSync(daemonStateDir(config.home), { recursive: true, mode: 0o700 });
  const log = await open(daemonLogPath(config.home), 'a', 0o600);
  const child = spawn(process.execPath, [...argv, cliPath(), 'once',
    '--home', config.home,
    ...(config.provider ? ['--provider', config.provider] : []),
    ...(config.model ? ['--model', config.model] : []),
    ...(config.projectId ? ['--project', config.projectId] : []),
    ...(config.sessionFile ? ['--session', config.sessionFile] : []),
  ], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PI_MEMORY_HOME: config.home, PI_SUBAGENTS_CHILD: '1' } });
  child.unref();
  await log.close();
  if (child.pid !== undefined) await writeFile(lock, String(child.pid), { mode: 0o600 });
  return child.pid;
};

const waitAlive = async (home: string, token: string, pid: number, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    const alive = await readAlive(home);
    if (alive && alive.token === token && alive.pid === pid) return;
    if (Date.now() >= deadline) throw new Error('pi-memory daemon did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
};

export const startDaemon = async (config: DaemonConfig, argv: readonly string[] = process.execArgv): Promise<DaemonPid> => {
  const current = await daemonStatus(config.home);
  if (current.running && current.pid) throw new Error(`pi-memory daemon already running as pid ${current.pid}.`);
  await reclaimStalePid(config.home);
  mkdirSync(daemonStateDir(config.home), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const claim: DaemonPid = { pid: process.pid, token, startedAt: new Date().toISOString(), home: config.home };
  await writePid(config.home, claim);
  const log = await open(daemonLogPath(config.home), 'a', 0o600);
  const child = spawn(process.execPath, [...argv, cliPath(), 'run',
    '--home', config.home,
    ...(config.provider ? ['--provider', config.provider] : []),
    ...(config.model ? ['--model', config.model] : []),
    '--interval-ms', String(config.intervalMs),
  ], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PI_MEMORY_HOME: config.home, PI_MEMORY_DAEMON_TOKEN: token } });
  child.unref();
  await log.close();
  const owned = async (): Promise<boolean> => (await readPid(config.home))?.token === token;
  if (child.pid === undefined) {
    if (await owned()) {
      await rm(daemonPidPath(config.home), { force: true });
      await rm(daemonAlivePath(config.home), { force: true });
    }
    throw new Error('Failed to start pi-memory daemon.');
  }
  const record: DaemonPid = { ...claim, pid: child.pid };
  try {
    await writeFile(daemonPidPath(config.home), JSON.stringify(record), { mode: 0o600 });
    await waitAlive(config.home, token, child.pid);
  } catch (error) {
    child.kill('SIGTERM');
    if (await owned()) {
      await rm(daemonPidPath(config.home), { force: true });
      await rm(daemonAlivePath(config.home), { force: true });
    }
    throw error;
  }
  return record;
};

export const reclaimStalePid = async (home: string): Promise<void> => {
  const path = daemonPidPath(home);
  const recorded = await readPid(home);
  if (recorded && await ownsProcess(home, recorded)) return;
  if (!recorded && !(await stat(path).catch(() => undefined))) return;
  const claim = `${path}.stale-${randomUUID()}`;
  await rename(path, claim).catch(() => undefined);
  await rm(claim, { force: true });
  await rm(daemonAlivePath(home), { force: true });
};
