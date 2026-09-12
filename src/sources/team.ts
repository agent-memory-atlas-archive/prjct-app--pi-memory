import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceDocument } from '../contracts/documents.ts';
import { sha256 } from '../workspace/project-identity.ts';
import type { SourceAdapter } from './registry.ts';

type TeamJournal = Readonly<{
  type?: string;
  at?: number;
  rootId?: string;
  broadcastId?: string;
  id?: string;
  subject?: string;
  requested?: string;
  delivered?: string;
  outcome?: string;
  files?: string[];
  tests?: string[];
  replies?: unknown[];
  body?: string;
}>;

type Capture = Readonly<{ artifactId: string; sha: string; at: number; path: string; name: string; stored: boolean; bytes: number }>;

const jsonLines = async <T>(path: string): Promise<T[]> => {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line) as T] : []; } catch { return []; }
  });
};

export class TeamJournalAdapter implements SourceAdapter {
  readonly id: string;
  private readonly mailboxRoot: string;
  private readonly teamName: string;
  private readonly teamId: string;
  private readonly prjctHome: string;

  constructor(options: { mailboxRoot: string; teamName: string; teamId: string; prjctHome: string }) {
    this.mailboxRoot = options.mailboxRoot;
    this.teamName = options.teamName;
    this.teamId = options.teamId;
    this.prjctHome = options.prjctHome;
    this.id = `pi-team:${options.teamId}`;
  }

  private async journalDocuments(signal?: AbortSignal): Promise<SourceDocument[]> {
    const root = join(this.mailboxRoot, this.teamName, 'journal');
    const files = (await readdir(root).catch(() => [] as string[])).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    const rows = (await Promise.all(files.map(async name => ({ name, rows: await jsonLines<TeamJournal>(join(root, name)) })))).flatMap(group =>
      group.rows.flatMap(row => ({ row, path: join(root, group.name) })));
    return rows.flatMap(({ row, path }) => {
      signal?.throwIfAborted();
      if (row.type !== 'thread' && row.type !== 'checkin') return [];
      const externalId = row.rootId ?? row.broadcastId ?? row.id;
      if (!externalId) return [];
      const text = row.type === 'thread'
        ? [row.subject, row.requested, row.delivered, row.outcome ? `Outcome: ${row.outcome}` : '',
          row.files?.length ? `Files: ${row.files.join(', ')}` : '', row.tests?.length ? `Tests: ${row.tests.join('; ')}` : ''].filter(Boolean).join('\n')
        : `Team check-in\n${JSON.stringify(row.replies ?? [])}`;
      const hash = sha256(text);
      return [{ namespace: 'pi-team.journal', externalId, scopeId: this.teamId, scopeKind: 'team' as const,
        source: 'pi-team', kind: row.type, ...(row.subject ? { title: row.subject } : {}), text, uri: path,
        version: hash, contentHash: hash, observedAt: new Date(row.at ?? 0).toISOString(), trust: 'imported' as const,
        metadata: { ...(row.outcome ? { outcome: row.outcome } : {}) } }];
    });
  }

  private async artifactDocuments(signal?: AbortSignal): Promise<SourceDocument[]> {
    const root = join(this.prjctHome, 'teams', this.teamId, 'team', 'artifacts');
    const indexRoot = join(root, 'index');
    const files = (await readdir(indexRoot).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl')).sort();
    const captures = (await Promise.all(files.map(name => jsonLines<Capture>(join(indexRoot, name))))).flat();
    const latest = captures.reduce<Map<string, Capture>>((map, capture) => {
      const prior = map.get(capture.artifactId);
      if (!prior || prior.at < capture.at) map.set(capture.artifactId, capture);
      return map;
    }, new Map());
    const documents = await Promise.all([...latest.values()].map(async (capture): Promise<SourceDocument | undefined> => {
      signal?.throwIfAborted();
      if (!capture.stored || capture.bytes > 512_000) return undefined;
      const body = await readFile(join(root, 'blobs', capture.sha), 'utf8').catch(() => undefined);
      if (!body?.trim()) return undefined;
      return { namespace: 'pi-team.artifact', externalId: capture.artifactId, scopeId: this.teamId, scopeKind: 'team' as const,
        source: 'pi-team', kind: 'artifact', title: capture.name, text: body, uri: capture.path,
        version: capture.sha, contentHash: capture.sha, observedAt: new Date(capture.at).toISOString(), trust: 'host' as const,
        metadata: { path: capture.path } } satisfies SourceDocument;
    }));
    return documents.filter((document): document is SourceDocument => document !== undefined);
  }

  async scan(signal?: AbortSignal): Promise<readonly SourceDocument[]> {
    return [...await this.journalDocuments(signal), ...await this.artifactDocuments(signal)];
  }
}
