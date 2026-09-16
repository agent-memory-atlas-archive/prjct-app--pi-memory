import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [root, output] = process.argv.slice(2);
if (!root || !output || dirname(output) === root) throw new Error('Sampler requires a root and an output outside that root.');
const bytes = path => existsSync(path) ? statSync(path).size : 0;
const treeBytes = path => !existsSync(path) ? 0 : readdirSync(path, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? treeBytes(join(path, entry.name)) : bytes(join(path, entry.name))), 0);
const measure = () => {
  const db = join(root, 'memory.sqlite');
  const parts = { sqlite: bytes(db), wal: bytes(`${db}-wal`), shm: bytes(`${db}-shm`),
    journal: treeBytes(join(root, 'events')) + bytes(`${db}-journal`), checkpoints: treeBytes(join(root, 'checkpoints')) };
  const subtotal = Object.values(parts).reduce((sum, value) => sum + value, 0);
  const total = treeBytes(root);
  return { ...parts, other: Math.max(0, total - subtotal), total };
};
const initial = measure();
const peak = { total: initial, wal: initial };
const sample = () => {
  const current = measure();
  if (current.total > peak.total.total) peak.total = current;
  if (current.wal > peak.wal.wal) peak.wal = current;
};
const publish = () => {
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, sampledAt: new Date().toISOString(), peakTotalSnapshot: peak.total,
    peakWalSnapshot: peak.wal }), { mode: 0o600 });
  renameSync(temporary, output);
};
const sampling = setInterval(sample, 2);
const publishing = setInterval(publish, 50);
publish();
const stop = () => {
  clearInterval(sampling);
  clearInterval(publishing);
  sample();
  publish();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
