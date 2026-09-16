import { join } from 'node:path';
import type { AdapterScope, SourceAdapter } from './registry.ts';
import { JsonRecordAdapter, type RecordMapping } from './records.ts';
import { assertSessionLogIsolation, SESSION_ADAPTER_ID, sessionLogRoot } from './session-log.ts';
import type { FieldRule, SelectionRules } from './shape.ts';

/**
 * Data-only mappings for pi-memory and optional team publishers. A caller can
 * override any part, and a new source needs a mapping here or none at all —
 * `JsonRecordAdapter` falls back to conventional field names.
 */

/**
 * pi-team's journal carries four entry types. `message` and `control` are the
 * turn-by-turn traffic of an exchange. A thread without a delivery is only a
 * request; a result message may contain the actual answer missing from the
 * thread summary. Keep published answers and reported check-in state, never
 * mere requests or interrupted-turn placeholders.
 */
export const TEAM_JOURNAL_SELECTION: SelectionRules = {
  keep: [
    { field: 'delivered', matches: '\\S' },
    { field: 'result.body', matches: '\\S' },
    { field: 'replies.*.state', matches: '\\S' },
  ],
  drop: [
    { field: 'type', equals: 'control' },
    { field: 'outcome', equals: 'interrupted' },
    { field: 'result.outcome', equals: 'interrupted' },
  ],
};

export const teamJournalMapping = (select: SelectionRules = TEAM_JOURNAL_SELECTION): RecordMapping => ({
  namespace: 'pi-team.journal',
  id: ['id', 'rootId', 'broadcastId'],
  text: ['subject'],
  title: ['subject'],
  observedAt: ['at'],
  kind: { rules: [{ when: [{ field: 'result.body', matches: '\\S' }], kind: 'result' }], from: ['type'], fallback: 'thread' },
  trust: 'imported',
  append: [
    { label: 'Result', field: 'result.body' },
    { label: 'Delivered', field: 'delivered' },
    { label: 'Outcome', field: 'outcome' },
    { label: 'Files', field: 'files' },
    { label: 'Tests', field: 'tests', join: '; ' },
    { label: 'Replies', field: 'replies.*.state' },
    { label: 'Request', field: 'requested' },
  ],
  metadata: { outcome: 'outcome', team: 'team', from: 'from', to: 'to', exchanges: 'exchanges', rootId: 'rootId' },
  maxChars: 64_000,
  select,
});

export const teamArtifactMapping = (blobDir: string): RecordMapping => ({
  namespace: 'pi-team.artifact',
  id: ['artifactId'],
  title: ['name'],
  uri: ['path'],
  observedAt: ['at'],
  kind: 'artifact',
  trust: 'host',
  contentFrom: { dir: blobDir, field: 'sha' },
  maxChars: 512_000,
  metadata: { path: 'path', alias: 'alias', tool: 'tool', bytes: 'bytes' },
  select: { keep: [{ field: 'stored', equals: true }], drop: [{ field: 'bytes', gt: 512_000 }] },
  latestPerId: true,
});

export const PI_SESSION_SELECTION: SelectionRules = {
  keep: [
    { field: 'outcome', equals: 'failed' },
    { field: 'kind', equals: 'failure' },
    { field: 'kind', equals: 'correction' },
    { field: 'kind', equals: 'instruction' },
  ],
  drop: [
    { field: 'tool', equals: 'memory_context' },
    { field: 'tool', equals: 'memory_record' },
  ],
};

export const piSessionMapping = (select: SelectionRules = PI_SESSION_SELECTION): RecordMapping => ({
  namespace: 'pi.session',
  id: ['id'],
  text: ['summary'],
  observedAt: ['observedAt'],
  kind: {
    rules: [
      { when: [{ field: 'kind', equals: 'failure' }], kind: 'failure' },
      { when: [{ field: 'kind', equals: 'correction' }], kind: 'correction' },
      { when: [{ field: 'kind', equals: 'instruction' }], kind: 'instruction' },
    ],
    from: ['kind'],
    fallback: 'observation',
  },
  trust: { from: 'provenance', when: { native_observation: 'host', declared: 'user' }, fallback: 'agent' },
  metadata: { tool: 'tool', outcome: 'outcome', sessionId: 'sessionId', semanticKey: 'semanticKey',
    summaryHash: 'summaryHash', capture: 'capture' },
  select,
  latestPerId: true,
  maxChars: 1_500,
});

export const piSessionSource = (options: Readonly<{
  home: string; scope: AdapterScope; select?: SelectionRules; mapping?: Partial<RecordMapping>;
}>): SourceAdapter => {
  const adapter = new JsonRecordAdapter({
    id: SESSION_ADAPTER_ID, scope: options.scope, source: 'pi-session',
    root: sessionLogRoot(options.scope.id, options.home), depth: 0,
    mapping: { ...piSessionMapping(options.select), ...options.mapping },
  });
  const isolated = async (): Promise<void> => { await assertSessionLogIsolation(options.scope.id, options.home); };
  return {
    id: adapter.id, scope: adapter.scope,
    scan: async signal => { await isolated(); return adapter.scan(signal); },
    snapshot: async signal => { await isolated(); return adapter.snapshot(signal); },
  };
};

export const teamJournalSource = (options: Readonly<{
  mailboxRoot: string; teamName: string; scope: AdapterScope; select?: SelectionRules; mapping?: Partial<RecordMapping>;
}>): JsonRecordAdapter => new JsonRecordAdapter({
  id: `pi-team:${options.scope.id}:journal`, scope: options.scope, source: 'pi-team',
  root: join(options.mailboxRoot, options.teamName, 'journal'),
  depth: 0,
  mapping: { ...teamJournalMapping(options.select), ...options.mapping },
});

export const teamArtifactSource = (options: Readonly<{
  home: string; scope: AdapterScope; mapping?: Partial<RecordMapping>;
}>): JsonRecordAdapter => {
  const root = join(options.home, 'teams', options.scope.id, 'team', 'artifacts');
  return new JsonRecordAdapter({
    id: `pi-team:${options.scope.id}:artifacts`, scope: options.scope, source: 'pi-team',
    root: join(root, 'index'), depth: 0,
    mapping: { ...teamArtifactMapping(join(root, 'blobs')), ...options.mapping },
  });
};

export type { FieldRule, SelectionRules };
