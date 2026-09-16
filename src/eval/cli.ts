import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tryCreateSdkAnalyzer } from '../curation/analyzer.ts';
import { CurationBlockError } from '../curation/types.ts';
import { MemoryEngine } from '../engine.ts';
import { createSdkAnswerProvider } from './answer.ts';
import {
  assertCases, assertCompareConfig, assertEmptyWorkspace, runComparison,
  type AnswerProvider, type CompareCase, type CompareConfig, type CompareReport, type EvidencePack,
} from './comparison.ts';
import { packEvidence } from './evidence.ts';

export type CompareInject = Readonly<{
  answer: AnswerProvider;
  pack: (query: string) => EvidencePack | Promise<EvidencePack>;
  memoryRoot?: string;
}>;

const arg = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

const rejected = (reason: string, status: CompareReport['status'] = 'rejected'): CompareReport => ({
  status, passed: false, reason,
  analysis: { provider: '', model: '' }, answer: { provider: '', model: '' },
  spend: { calls: 0, inputTokens: 0, outputTokens: 0, failedCalls: 0 },
  storage: { sqliteBytes: 0, walBytes: 0, shmBytes: 0, journalBytes: 0, checkpointBytes: 0 },
  latencyMs: { samples: [], cold: 0, warm: 0, p95: 0 },
  cases: [],
});

export const runCompareCli = async (argv: readonly string[], inject?: CompareInject): Promise<CompareReport> => {
  const configPath = arg(argv, '--config');
  const casesPath = arg(argv, '--cases');
  const workspaceArg = arg(argv, '--workspace');
  if (!configPath || !casesPath || !workspaceArg) return rejected('Usage: eval-compare --config <json> --cases <json> --workspace <dir> [--dry-run]');
  const workspace = resolve(workspaceArg);
  const info = await stat(workspace).catch(() => undefined);
  if (!info?.isDirectory()) return rejected('workspace must be an existing directory.');
  await mkdir(workspace, { recursive: true, mode: 0o700 }).catch(() => undefined);
  try {
    await assertEmptyWorkspace(workspace);
  } catch (error) {
    return rejected(error instanceof Error ? error.message : String(error));
  }
  const config = assertCompareConfig({
    ...JSON.parse(await readFile(resolve(configPath), 'utf8')) as Partial<CompareConfig>,
    workspace,
  });
  const cases = assertCases(JSON.parse(await readFile(resolve(casesPath), 'utf8')) as CompareCase[]);
  if (argv.includes('--dry-run')) {
    return {
      ...rejected('Dry-run validated config, cases and empty workspace. No inference ran.', 'unreviewed'),
      analysis: config.analysis, answer: config.answer,
    };
  }
  if (inject) {
    return runComparison({ config, cases, answer: inject.answer, pack: inject.pack, memoryRoot: inject.memoryRoot });
  }
  const analyzer = await tryCreateSdkAnalyzer(config.analysis);
  if (!analyzer.analyzer) {
    return { ...rejected(analyzer.block?.message ?? 'Analysis provider is unavailable.', 'blocked'),
      analysis: config.analysis, answer: config.answer };
  }
  try {
    const answer = await createSdkAnswerProvider(config.answer);
    const engine = await MemoryEngine.forScope('project', config.projectId, 'eval-compare', { home: workspace });
    try {
      return await runComparison({
        config, cases, answer,
        pack: query => packEvidence(engine, query),
        memoryRoot: engine.root,
      });
    } finally {
      await engine.dispose();
    }
  } catch (error) {
    const blocked = error instanceof CurationBlockError;
    return {
      ...rejected(error instanceof Error ? error.message : String(error), blocked ? 'blocked' : 'rejected'),
      analysis: config.analysis, answer: config.answer,
    };
  }
};
