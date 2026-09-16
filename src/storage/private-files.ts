import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';

const ownedByProcess = (uid: number): boolean => !process.getuid || uid === process.getuid();

export const privateDirectorySync = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || !ownedByProcess(before.uid)) throw new Error(`Unsafe memory directory: ${path}`);
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if ((after.mode & 0o077) !== 0) throw new Error(`Memory directory is not private: ${path}`);
};

export const privateDatabaseFiles = (path: string): void => {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || !ownedByProcess(info.uid)) throw new Error(`Unsafe memory database file: ${file}`);
    chmodSync(file, 0o600);
  }
};
