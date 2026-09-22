import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSourceDocument, type SourceDocument } from '../contracts/documents.ts';
import { sha256 } from '../workspace/project-identity.ts';
import type { AdapterScope, SourceAdapter, SourceSnapshot } from './registry.ts';
import { assertSessionLogIsolation, sessionLogRoot, type SessionObservation } from './session-log.ts';

/**
 * One document per session instead of one per observation.
 *
 * The per-observation adapter asks the analyser to explain a single tool
 * failure, so it can only ever answer "this read failed because the file was
 * not there" — a reworded transcript line. A measured run produced 67 topics
 * from 85 observations, a third of them restating that a path did not exist.
 *
 * Knowledge lives between the observations: what was being attempted, what
 * broke, what that says about the repository. That only becomes visible when a
 * whole session is the unit of analysis, which is also what `LivingContext`
 * (goal, decisions, blocked, nextSteps) was shaped to hold.
 */

export const SESSION_DIGEST_ADAPTER_ID = 'pi-session-digest';

/**
 * A session still receiving observations would be re-analysed on every cycle,
 * paying for the same work repeatedly. Sessions are digested once they have
 * been quiet for this long.
 */
export const DEFAULT_SETTLE_MS = 30 * 60_000;

/** Read every observation the project has logged, oldest first. */
export const readSessionObservations = async (root: string): Promise<SessionObservation[]> => {
  const names = await readdir(root).catch(() => [] as string[]);
  const records: SessionObservation[] = [];
  for (const name of names.filter(file => file.endsWith('.jsonl')).sort()) {
    const raw = await readFile(join(root, name), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as SessionObservation;
        if (parsed?.id && parsed.sessionId && parsed.summary) records.push(parsed);
      } catch {
        // A truncated trailing line is normal while a session is being written.
      }
    }
  }
  return records.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
};

/** The header both halves share: what session, when, how much. */
const frame = (records: readonly SessionObservation[]): string[] => [
  `# Session ${records[0]?.sessionId ?? 'unknown'}`,
  `From ${records[0]?.observedAt ?? ''} to ${records.at(-1)?.observedAt ?? ''}. ${records.length} observations.`,
  '',
];

const lines = (title: string, rows: readonly SessionObservation[]): string[] =>
  rows.length ? [`## ${title}`, ...rows.map(row => `- [${row.tool}] ${row.summary.replaceAll('\n', ' ')}`), ''] : [];

const declaredOf = (records: readonly SessionObservation[]): SessionObservation[] =>
  records.filter(record => record.kind === 'correction' || record.kind === 'instruction');
const observedOf = (records: readonly SessionObservation[]): SessionObservation[] =>
  records.filter(record => record.kind === 'failure');

/** The whole session as one readable brief; used by the declared/observed halves. */
export const digestText = (records: readonly SessionObservation[]): string =>
  [...frame(records), ...lines('What the user corrected or instructed', declaredOf(records)),
    ...lines('What failed while working', observedOf(records))].join('\n').trim();

const declaredText = (records: readonly SessionObservation[]): string =>
  [...frame(records), ...lines('What the user corrected or instructed', declaredOf(records))].join('\n').trim();

const observedText = (records: readonly SessionObservation[]): string =>
  [...frame(records), ...lines('Context the user gave in this session', declaredOf(records)),
    ...lines('What failed while working', observedOf(records))].join('\n').trim();

/**
 * A session yields up to two documents, split by who is speaking.
 *
 * Collapsing both into one made everything the user declared arrive as a
 * `native_observation`: "create pull requests targeting develop" stopped being
 * something a person said and became something the machine noticed. Provenance
 * is what the publication gate and the value score read, so laundering it that
 * way is not cosmetic.
 *
 * The observed half still carries the declared lines as framing, because that
 * is where the relation between what was attempted and what broke lives — but
 * it carries them as context it cannot republish as a user's instruction.
 */
export const sessionDigestDocuments = (scope: AdapterScope, records: readonly SessionObservation[],
  now: number, settleMs: number): SourceDocument[] => {
  const sessions = new Map<string, SessionObservation[]>();
  for (const record of records) {
    const bucket = sessions.get(record.sessionId);
    if (bucket) bucket.push(record);
    else sessions.set(record.sessionId, [record]);
  }
  const documents: SourceDocument[] = [];
  for (const [sessionId, rows] of sessions) {
    const last = Date.parse(rows.at(-1)!.observedAt);
    if (Number.isFinite(last) && now - last < settleMs) continue;
    const halves = [
      { suffix: 'declared', text: declaredText(rows), rows: declaredOf(rows), trust: 'user' as const, kind: 'correction' },
      { suffix: 'observed', text: observedText(rows), rows: observedOf(rows), trust: 'host' as const, kind: 'failure' },
    ];
    for (const half of halves) {
      if (!half.rows.length) continue;
      const contentHash = sha256(half.text);
      documents.push(assertSourceDocument({
        namespace: 'pi.session.digest', externalId: `session:${sessionId}:${half.suffix}`,
        scopeId: scope.id, scopeKind: scope.kind, source: 'pi-session', kind: half.kind,
        title: `Session ${sessionId} (${half.suffix})`, text: half.text,
        // The revision follows the content, so a session that gained observations
        // is re-analysed once and an unchanged one is never paid for twice.
        version: contentHash.slice(0, 16), contentHash,
        observedAt: rows.at(-1)!.observedAt, trust: half.trust,
        metadata: { sessionId, observations: String(rows.length),
          failures: String(observedOf(rows).length), corrections: String(declaredOf(rows).length) },
      }));
    }
  }
  return documents;
};

export const piSessionDigestSource = (options: Readonly<{
  home: string; scope: AdapterScope; settleMs?: number; now?: () => number;
}>): SourceAdapter => {
  const root = sessionLogRoot(options.scope.id, options.home);
  const collect = async (): Promise<SourceDocument[]> => {
    await assertSessionLogIsolation(options.scope.id, options.home);
    const records = await readSessionObservations(root);
    return sessionDigestDocuments(options.scope, records, (options.now ?? Date.now)(),
      options.settleMs ?? DEFAULT_SETTLE_MS);
  };
  return {
    id: SESSION_DIGEST_ADAPTER_ID, scope: options.scope,
    scan: async () => collect(),
    // Authoritative: every settled session this project has is in the scan, so
    // a digest whose session log was pruned may be retired.
    snapshot: async (): Promise<SourceSnapshot> => ({ documents: await collect(), complete: true, gaps: [] }),
  };
};
