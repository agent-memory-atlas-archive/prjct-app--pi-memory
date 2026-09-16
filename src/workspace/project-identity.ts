import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ScopeKind } from '../contracts/documents.ts';

export const MEMORY_COMPONENT = 'memory';
export const MEMORY_DATABASE = 'memory.sqlite';
export const SHARED_SCOPE_ID = 'shared';
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const prjctHomeFor = (override?: string): string => override ?? process.env.PRJCT_HOME ?? join(homedir(), '.prjct');
export const projectIdFrom = (canonicalLocation: string): string => `p_${sha256(canonicalLocation).slice(0, 12)}`;
export const checkoutIdFrom = (canonicalLocation: string): string => `co_${sha256(canonicalLocation).slice(0, 12)}`;
export const assertProjectId = (projectId: string): string => {
  if (!/^p_[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('Memory opens only a project-owned database.');
  return projectId;
};
export const memoryDatabasePath = (home: string, projectId: string): string =>
  join(componentPath(home, 'project', assertProjectId(projectId)), MEMORY_DATABASE);
export const assertProjectLocalPath = (root: string, candidate: string): string => {
  const expectedRoot = resolve(root);
  const target = resolve(candidate);
  const prefix = `${expectedRoot.replaceAll('\\', '/')}/`;
  if (target !== expectedRoot && !target.replaceAll('\\', '/').startsWith(prefix)) throw new Error('Memory path escaped the project authority.');
  const nearest = (path: string): string => existsSync(path) ? path : path === dirname(path) ? path : nearest(dirname(path));
  const realRoot = realpathSync(expectedRoot).replaceAll('\\', '/');
  const realNearest = realpathSync(nearest(target)).replaceAll('\\', '/');
  if (realNearest !== realRoot && !realNearest.startsWith(`${realRoot}/`)) throw new Error('Memory path resolves outside the project authority.');
  return target;
};

export const assertExclusiveMemoryPath = (home: string, projectId: string, candidate: string): string => {
  const expected = resolve(memoryDatabasePath(home, projectId));
  if (resolve(candidate) !== expected) throw new Error('Memory path is not the exclusive database for this project.');
  const projectRoot = resolve(home, projectId);
  const prefix = `${projectRoot.replaceAll('\\', '/')}/`;
  if (!expected.replaceAll('\\', '/').startsWith(prefix)) throw new Error('Memory path escaped the project root.');
  const live = existsSync(expected) ? expected : dirname(expected);
  if (existsSync(live)) {
    const real = realpathSync(live).replaceAll('\\', '/');
    const realProject = (existsSync(projectRoot) ? realpathSync(projectRoot) : projectRoot).replaceAll('\\', '/');
    const realHome = (existsSync(home) ? realpathSync(home) : resolve(home)).replaceAll('\\', '/');
    if (real !== realProject && !real.startsWith(`${realProject}/`)) throw new Error('Memory path resolves to another project.');
    if (real !== realHome && !real.startsWith(`${realHome}/`)) throw new Error('Memory path resolves outside PRJCT_HOME.');
  }
  return expected;
};

export const scopeRoot = (home: string, kind: ScopeKind, id: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('A scope root requires a plain id.');
  if (kind === 'project' && !/^p_[A-Za-z0-9_-]+$/.test(id)) throw new Error('A project scope requires a p_ id.');
  if (kind === 'shared' && id !== SHARED_SCOPE_ID) throw new Error('The shared scope id is fixed.');
  const root = kind === 'project' ? resolve(home, id) : kind === 'team' ? resolve(home, 'teams', id) : resolve(home, SHARED_SCOPE_ID);
  if (!root.replaceAll('\\', '/').startsWith(`${resolve(home).replaceAll('\\', '/')}/`)) throw new Error('Scope root escaped PRJCT_HOME.');
  return root;
};

export const componentPath = (home: string, kind: ScopeKind, id: string, component = MEMORY_COMPONENT): string => {
  if (!/^[a-z][a-z0-9-]*$/.test(component)) throw new Error('Invalid component name.');
  return join(scopeRoot(home, kind, id), component);
};

type IdentityBinding = Readonly<{ location: string; projectId: string }>;

const locatorProjectId = async (location: string): Promise<string | undefined> => {
  const raw = await readFile(join(location, '.prjct', 'prjct.config.json'), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const projectId = (parsed as { projectId?: unknown }).projectId;
    return typeof projectId === 'string' && /^p_[A-Za-z0-9_-]+$/.test(projectId) ? projectId : undefined;
  } catch {
    return undefined;
  }
};

const verifiedBindings = async (home: string): Promise<readonly IdentityBinding[]> => {
  const raw = await readFile(join(home, 'identity', 'index.json'), 'utf8').catch(() => undefined);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const envelope = parsed as { schemaVersion?: unknown; revision?: unknown; contentHash?: unknown; payload?: unknown };
    if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) || Number(envelope.revision) < 1
      || typeof envelope.contentHash !== 'string' || sha256(JSON.stringify(envelope.payload)) !== envelope.contentHash
      || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return [];
    const bindings = (envelope.payload as { bindings?: unknown }).bindings;
    if (!Array.isArray(bindings)) return [];
    return bindings.flatMap(binding => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return [];
      const row = binding as { location?: unknown; projectId?: unknown };
      return typeof row.location === 'string' && typeof row.projectId === 'string' && /^p_[A-Za-z0-9_-]+$/.test(row.projectId)
        ? [{ location: resolve(row.location), projectId: row.projectId }]
        : [];
    });
  } catch {
    return [];
  }
};

export const trustedProjectIds = async (home: string): Promise<readonly string[]> =>
  [...new Set((await verifiedBindings(home)).map(binding => binding.projectId))].sort();

export const resolveProject = async (cwd: string, home = prjctHomeFor()): Promise<{ location: string; projectId: string; checkoutId: string }> => {
  const location = await realpath(resolve(cwd));
  const located = await locatorProjectId(location);
  const trusted = located && (await verifiedBindings(home)).some(binding => binding.location === location && binding.projectId === located);
  return { location, projectId: trusted ? located : projectIdFrom(location), checkoutId: checkoutIdFrom(location) };
};
