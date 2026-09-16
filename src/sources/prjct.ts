import { join } from 'node:path';
import type { AdapterScope } from './registry.ts';
import { JsonRecordAdapter, type RecordMapping } from './records.ts';
import type { SelectionRules } from './shape.ts';

/**
 * Optional compatibility adapter for prjct's published observation format.
 * This module imports no prjct code and is never registered implicitly.
 */
export const PRJCT_OBSERVATION_SELECTION: SelectionRules = {
  keep: [
    { field: 'execution.outcome', equals: 'failed' },
    { field: 'verification', equals: true },
    { field: 'provenance', equals: 'declared' },
  ],
};

export const prjctObservationMapping = (select: SelectionRules = PRJCT_OBSERVATION_SELECTION): RecordMapping => ({
  namespace: 'prjct.observation',
  container: 'payload.observations',
  id: ['id'],
  text: ['summary'],
  observedAt: ['recordedAt'],
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

export const prjctObservationSource = (options: Readonly<{
  home: string; scope: AdapterScope; select?: SelectionRules; mapping?: Partial<RecordMapping>;
}>): JsonRecordAdapter => new JsonRecordAdapter({
  id: 'prjct-observations', scope: options.scope, source: 'prjct',
  root: join(options.home, options.scope.id, 'prjct', 'work', 'sessions'),
  depth: 2,
  mapping: { ...prjctObservationMapping(options.select), ...options.mapping },
});
