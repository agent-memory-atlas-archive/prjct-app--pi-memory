import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export const acquireMaintenanceLock = (root: string, retried = false): (() => void) => {
  const path = join(root, 'storage-maintenance.lock');
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
    return () => {
      try { closeSync(fd); } finally { rmSync(path, { force: true }); }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!retried && !processAlive(owner)) {
      rmSync(path, { force: true });
      return acquireMaintenanceLock(root, true);
    }
    throw new Error(`Memory storage maintenance is already running${Number.isSafeInteger(owner) ? ` in process ${owner}` : ''}.`);
  }
};
