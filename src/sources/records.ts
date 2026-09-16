import { createReadStream } from 'node:fs';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { extname, join } from 'node:path';
import type { SourceDocument } from '../contracts/documents.ts';
import { sha256 } from '../workspace/project-identity.ts';
import type { AdapterScope, SourceAdapter, SourceSnapshot } from './registry.ts';
import {
  ID_HINTS, KIND_HINTS, TEXT_HINTS, TIME_HINTS, TITLE_HINTS,
  firstText, firstTimestamp, isRecord, matchesRule, paths, selects, valueAt, valuesAt,
  type FieldPath, type FieldRule, type JsonRecord, type SelectionRules,
} from './shape.ts';

/**
 * Describes where the parts of a document live inside someone else's record.
 * Every path list is optional: what is not declared is looked for under the
 * conventional names in `shape.ts`, so a source with ordinary field names needs
 * no mapping at all and an unusual one needs a mapping rather than a new class.
 */
export type RecordMapping = Readonly<{
  namespace: string;
  /** Path to the array of records inside a `.json` file; omit if the file is one record, or a `.jsonl`. */
  container?: FieldPath;
  id?: readonly FieldPath[];
  text?: readonly FieldPath[];
  title?: readonly FieldPath[];
  observedAt?: readonly FieldPath[];
  validFrom?: readonly FieldPath[];
  validTo?: readonly FieldPath[];
  uri?: readonly FieldPath[];
  /**
   * A literal kind, or how to derive one. `rules` are tried in order and the
   * first whose conditions all hold wins, then `from` paths are read, then
   * `fallback`. This is what lets a publisher that encodes kind in an outcome
   * or a tool name classify without any code knowing those field names.
   */
  kind?: string | Readonly<{
    rules?: readonly Readonly<{ when: readonly FieldRule[]; kind: string }>[];
    from?: readonly FieldPath[];
    fallback?: string;
  }>;
  /** A literal trust level, or a mapping from a field's value. */
  trust?: SourceDocument['trust'] | Readonly<{ from: FieldPath; when: Readonly<Record<string, SourceDocument['trust']>>; fallback: SourceDocument['trust'] }>;
  /** Extra lines appended to the text, skipped when the field is absent. */
  append?: readonly Readonly<{ label?: string; field: FieldPath; join?: string }>[];
  metadata?: Readonly<Record<string, FieldPath>>;
  select?: SelectionRules;
  /** Content is not in the record: read it from `join(dir, <field value>)`. */
  contentFrom?: Readonly<{ dir: string; field: FieldPath; maxBytes?: number }>;
  /** Keep only the newest record per id, by observedAt. */
  latestPerId?: boolean;
  maxChars?: number;
}>;

export type RecordSourceOptions = Readonly<{
  id: string;
  scope: AdapterScope;
  /** Directory walked for `.json` and `.jsonl` files. */
  root: string;
  mapping: RecordMapping;
  /** How deep to walk below `root`. */
  depth?: number;
  source?: string;
}>;

const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_BLOB_BYTES = 512_000;
const MAX_RECORD_FILE_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_LINE_CHARS = 1024 * 1024;

const walk = async (root: string, depth: number, gaps: string[]): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    gaps.push('Source directory unavailable; retained index may be stale.');
    return [];
  });
  const here = entries.filter(entry => entry.isFile() && ['.json', '.jsonl'].includes(extname(entry.name)))
    .map(entry => join(root, entry.name));
  if (depth <= 0) return here.sort();
  const nested: string[] = [];
  for (const entry of entries.filter(item => item.isDirectory())) nested.push(...await walk(join(root, entry.name), depth - 1, gaps));
  return [...here, ...nested].sort();
};

const recordsIn = async (path: string, container: FieldPath | undefined, gaps: string[]): Promise<JsonRecord[]> => {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_FILE_BYTES) {
    gaps.push('Source record file is unavailable, unsafe, or oversized; retained index may be stale.');
    return [];
  }
  if (extname(path) === '.jsonl') {
    const rows: JsonRecord[] = [];
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > MAX_JSONL_LINE_CHARS) {
          gaps.push('Source JSONL line is oversized; retained index may be stale.');
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) rows.push(parsed);
          else gaps.push('Source JSONL record is not an object; retained index may be stale.');
        } catch {
          gaps.push('Source JSONL record is malformed; retained index may be stale.');
        }
      }
    } finally {
      lines.close();
    }
    return rows;
  }
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) {
      gaps.push('Source JSON file is empty; retained index may be stale.');
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    const found = container ? valuesAt(parsed, container) : [parsed];
    if (!found.length || found.some(value => Array.isArray(value) ? value.some(row => !isRecord(row)) : !isRecord(value))) {
      gaps.push('Source record container is missing or invalid; retained index may be stale.');
      return [];
    }
    return found.flatMap(value => Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []);
  } catch {
    gaps.push('Source JSON file is malformed; retained index may be stale.');
    return [];
  }
};

const observedAtOf = (record: JsonRecord, mapping: RecordMapping): string => {
  const declared = paths(mapping.observedAt, TIME_HINTS);
  const stamp = firstTimestamp(record, declared);
  if (!stamp && declared.some(path => valuesAt(record, path).some(value => value !== null))) {
    throw new Error('Invalid observation timestamp in source record.');
  }
  return stamp ?? new Date(0).toISOString();
};

const trustOf = (record: JsonRecord, mapping: RecordMapping): SourceDocument['trust'] => {
  const declared = mapping.trust;
  if (declared === undefined) return 'imported';
  if (typeof declared === 'string') return declared;
  const value = valueAt(record, declared.from);
  return (typeof value === 'string' ? declared.when[value] : undefined) ?? declared.fallback;
};

const kindOf = (record: JsonRecord, mapping: RecordMapping): string => {
  const declared = mapping.kind;
  if (typeof declared === 'string') return declared;
  const ruled = declared?.rules?.find(rule => rule.when.every(condition => matchesRule(record, condition)));
  if (ruled) return ruled.kind;
  const found = firstText(record, paths(declared?.from, KIND_HINTS));
  return found ?? declared?.fallback ?? 'record';
};

const textOf = (record: JsonRecord, mapping: RecordMapping): string | undefined => {
  const base = firstText(record, paths(mapping.text, TEXT_HINTS));
  const extra = (mapping.append ?? []).flatMap(part => {
    const values = valuesAt(record, part.field)
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(value => typeof value === 'string' || typeof value === 'number')
      .map(String);
    if (!values.length) return [];
    return [`${part.label ? `${part.label}: ` : ''}${values.join(part.join ?? ', ')}`];
  });
  const joined = [base, ...extra].filter(Boolean).join('\n');
  return joined.trim() ? joined : undefined;
};

/**
 * Turns a tree of JSON or JSONL records into source documents. It knows nothing
 * about any particular publisher: give it a root and a mapping.
 */
export class JsonRecordAdapter implements SourceAdapter {
  readonly id: string;
  readonly scope: AdapterScope;
  private readonly root: string;
  private readonly mapping: RecordMapping;
  private readonly depth: number;
  private readonly source: string;

  constructor(options: RecordSourceOptions) {
    this.id = options.id;
    this.scope = options.scope;
    this.root = options.root;
    this.mapping = options.mapping;
    this.depth = options.depth ?? 3;
    this.source = options.source ?? options.mapping.namespace;
  }

  private async documentFor(record: JsonRecord, path: string, gaps: string[], signal?: AbortSignal): Promise<SourceDocument | undefined> {
    signal?.throwIfAborted();
    if (!selects(record, this.mapping.select ?? {})) return undefined;
    const externalId = firstText(record, paths(this.mapping.id, ID_HINTS));
    if (!externalId) {
      gaps.push('Selected source record has no identity; retained index may be stale.');
      return undefined;
    }
    const blob = this.mapping.contentFrom;
    const body = blob ? await (async (): Promise<string | undefined> => {
      const name = firstText(record, [blob.field]);
      if (!name || /[/\\]/.test(name)) return undefined;
      const file = join(blob.dir, name);
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > (blob.maxBytes ?? DEFAULT_BLOB_BYTES)) return undefined;
      return readFile(file, 'utf8').catch(() => undefined);
    })() : textOf(record, this.mapping);
    if (!body?.trim()) {
      gaps.push('Selected source content unavailable; retained index may be stale.');
      return undefined;
    }
    const text = body.slice(0, this.mapping.maxChars ?? DEFAULT_MAX_CHARS);
    const hash = sha256(text);
    const title = firstText(record, paths(this.mapping.title, TITLE_HINTS));
    const uri = firstText(record, paths(this.mapping.uri, [])) ?? path;
    const validity = (field: 'validFrom' | 'validTo'): string | undefined => {
      const declared = paths(this.mapping[field], [field]);
      const present = declared.some(path => valuesAt(record, path).some(value => value !== null));
      const stamp = firstTimestamp(record, declared);
      if (present && !stamp) throw new Error(`Invalid ${field} in source record ${externalId}.`);
      return stamp;
    };
    const validFrom = validity('validFrom');
    const validTo = validity('validTo');
    const metadata = Object.fromEntries(Object.entries(this.mapping.metadata ?? {}).flatMap(([key, field]) => {
      const value = valueAt(record, field);
      return value === undefined || typeof value === 'object' ? [] : [[key, String(value)]];
    }));
    return { namespace: this.mapping.namespace, externalId, scopeId: this.scope.id, scopeKind: this.scope.kind,
      source: this.source, kind: kindOf(record, this.mapping), ...(title ? { title } : {}), text, uri,
      version: hash, contentHash: hash,
      observedAt: observedAtOf(record, this.mapping),
      ...(validFrom ? { validFrom } : {}), ...(validTo ? { validTo } : {}),
      trust: trustOf(record, this.mapping), metadata };
  }

  async scan(signal?: AbortSignal): Promise<readonly SourceDocument[]> {
    return (await this.snapshot(signal)).documents;
  }

  async snapshot(signal?: AbortSignal): Promise<SourceSnapshot> {
    signal?.throwIfAborted();
    const gaps: string[] = [];
    const files = await walk(this.root, this.depth, gaps);
    const rows: { record: JsonRecord; path: string }[] = [];
    for (const path of files) rows.push(...(await recordsIn(path, this.mapping.container, gaps)).map(record => ({ record, path })));
    // Choose the latest raw revision BEFORE selection/materialization. Otherwise
    // a newer withdrawn or unavailable revision resurrects an older answer.
    const newest = this.mapping.latestPerId ? [...rows.reduce<Map<string, typeof rows[number]>>((map, row) => {
      const id = firstText(row.record, paths(this.mapping.id, ID_HINTS));
      if (!id) {
        if (selects(row.record, this.mapping.select ?? {})) gaps.push('Selected source record has no identity; retained index may be stale.');
        return map;
      }
      const prior = map.get(id);
      const time = (record: JsonRecord): number => Date.parse(observedAtOf(record, this.mapping));
      if (!prior || time(prior.record) <= time(row.record)) map.set(id, row);
      return map;
    }, new Map()).values()] : rows;
    const materialized: Array<SourceDocument | undefined> = [];
    for (const row of newest) materialized.push(await this.documentFor(row.record, row.path, gaps, signal));
    const documents = materialized.filter((document): document is SourceDocument => document !== undefined);
    signal?.throwIfAborted();
    return { documents, complete: !gaps.length, gaps: [...new Set(gaps)] };
  }
}
