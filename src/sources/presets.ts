import { join } from 'node:path';
import type { AdapterScope } from './registry.ts';
import { JsonRecordAdapter, type RecordMapping } from './records.ts';
import type { FieldRule, SelectionRules } from './shape.ts';

/**
 * Mappings for the siblings that publish into a prjct home today. They are
 * data, not code: a caller can override any part, and a source that appears
 * tomorrow needs a mapping here or none at all — `JsonRecordAdapter` falls back
 * to conventional field names when nothing is declared.
 *
 * Neither prjct nor pi-team is imported. The only shared surface is the
 * directory rule prjct publishes and the marker file each scope carries.
 */

/**
 * prjct records an observation per tool call, so most of the stream is routine
 * work — on a real machine 485 of 1,503 were file reads whose entire summary is
 * "read completed: CONTRIBUTING.md 22 lines, 1776 B". pi-memory's own rule is to
 * keep corrections, decisions, verified failures and explicit user statements
 * and leave routine reads alone, so the selection happens on the way in.
 */
export const PRJCT_OBSERVATION_SELECTION: SelectionRules = {
  keep: [
    { field: 'execution.outcome', equals: 'failed' },
    { field: 'verification', equals: true },
    { field: 'execution.toolName', oneOf: ['user_input'] },
  ],
};

export const prjctObservationMapping = (select: SelectionRules = PRJCT_OBSERVATION_SELECTION): RecordMapping => ({
  namespace: 'prjct.observation',
  container: 'payload.observations',
  id: ['id'],
  text: ['summary'],
  observedAt: ['recordedAt'],
  // Kind is derived from the record rather than assumed: prjct encodes it in
  // the execution outcome and the tool that produced the observation.
  kind: {
    rules: [
      { when: [{ field: 'execution.outcome', equals: 'failed' }], kind: 'failure' },
      { when: [{ field: 'execution.toolName', equals: 'user_input' }], kind: 'instruction' },
      { when: [{ field: 'verification', equals: true }], kind: 'verification' },
    ],
    from: [],
    fallback: 'observation',
  },
  trust: { from: 'provenance', when: { native_observation: 'host', declared: 'user' }, fallback: 'agent' },
  append: [{ label: 'Command', field: 'execution.command' }, { label: 'Paths', field: 'execution.sourcePaths' }],
  metadata: { tool: 'execution.toolName', outcome: 'execution.outcome', workId: 'workId', taskId: 'taskId' },
  select,
  maxChars: 4_000,
});

/**
 * pi-team's journal carries four entry types. `message` and `control` are the
 * turn-by-turn traffic of an exchange; `thread` is its outcome and `checkin` a
 * round of reported state. Only the settled two are durable knowledge — the 487
 * raw messages on a real machine are narration.
 */
export const TEAM_JOURNAL_SELECTION: SelectionRules = {
  keep: [{ field: 'type', oneOf: ['thread', 'checkin'] }],
};

export const teamJournalMapping = (select: SelectionRules = TEAM_JOURNAL_SELECTION): RecordMapping => ({
  namespace: 'pi-team.journal',
  id: ['rootId', 'broadcastId', 'id'],
  text: ['requested', 'subject'],
  title: ['subject'],
  observedAt: ['at'],
  kind: { from: ['type'], fallback: 'thread' },
  trust: 'imported',
  append: [
    { label: 'Delivered', field: 'delivered' },
    { label: 'Outcome', field: 'outcome' },
    { label: 'Files', field: 'files' },
    { label: 'Tests', field: 'tests', join: '; ' },
    { label: 'Replies', field: 'replies.*.state' },
  ],
  metadata: { outcome: 'outcome', team: 'team', from: 'from', to: 'to', exchanges: 'exchanges' },
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
  metadata: { path: 'path', alias: 'alias', tool: 'tool', bytes: 'bytes' },
  select: { keep: [{ field: 'stored', equals: true }], drop: [{ field: 'bytes', gt: 512_000 }] },
  latestPerId: true,
});

export const prjctObservationSource = (options: Readonly<{
  home: string; scope: AdapterScope; select?: SelectionRules; mapping?: Partial<RecordMapping>;
}>): JsonRecordAdapter => new JsonRecordAdapter({
  id: 'prjct-observations', scope: options.scope, source: 'prjct',
  root: join(options.home, options.scope.id, 'prjct', 'work', 'sessions'),
  depth: 2,
  mapping: { ...prjctObservationMapping(options.select), ...options.mapping },
});

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
