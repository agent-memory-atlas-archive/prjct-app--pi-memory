import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_DATABASE } from '../workspace/project-identity.ts';

export const COMPARE_CONDITIONS = ['evidence-complete', 'previous-document', 'curated-memory'] as const;
export type CompareCondition = (typeof COMPARE_CONDITIONS)[number];

export type CompareConfig = Readonly<{
  workspace: string;
  projectId: string;
  analysis: Readonly<{ provider: string; model: string }>;
  answer: Readonly<{ provider: string; model: string }>;
  budget: Readonly<{ maxCallsPerDay: number; maxTokensPerDay: number; maxUsd?: number }>;
  deadlineMs?: number;
}>;

export type CompareCase = Readonly<{
  name: string;
  query: string;
  required: readonly string[];
  excluded?: readonly string[];
  citations?: readonly string[];
  conditions?: readonly string[];
}>;

export type AnswerRequest = Readonly<{
  query: string;
  evidence: string;
  condition: CompareCondition;
  priorFacts: readonly string[];
}>;

export type AnswerResult = Readonly<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  failed?: boolean;
}>;

export type AnswerProvider = Readonly<{
  provider: string;
  model: string;
  answer(request: AnswerRequest, signal?: AbortSignal): Promise<AnswerResult>;
}>;

export type EvidencePack = Readonly<{
  evidenceComplete: string;
  previousDocument: string;
  curatedMemory: string;
  priorFacts: readonly string[];
}>;

export type Diagnostics = Readonly<{
  missingRequired: readonly string[];
  unsupported: readonly string[];
  missingCitations: readonly string[];
  missingConditions: readonly string[];
}>;

export type CaseReport = Readonly<{
  name: string;
  condition: CompareCondition;
  answer: string;
  diagnostics: Diagnostics;
  adjudication: 'unreviewed' | 'failed';
}>;

export type CompareReport = Readonly<{
  status: 'ok' | 'blocked' | 'unreviewed' | 'rejected';
  reason?: string;
  analysis: CompareConfig['analysis'];
  answer: CompareConfig['answer'];
  spend: { calls: number; inputTokens: number; outputTokens: number; failedCalls: number };
  storage: { sqliteBytes: number; walBytes: number; shmBytes: number; journalBytes: number; checkpointBytes: number };
  latencyMs: { samples: readonly number[]; cold: number; warm: number; p95: number };
  cases: readonly CaseReport[];
  passed: boolean;
}>;

const requiredText = (value: string | undefined, label: string): string => {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
};

export const assertCompareConfig = (config: Partial<CompareConfig>): CompareConfig => {
  const workspace = requiredText(config.workspace, 'workspace');
  const projectId = requiredText(config.projectId, 'projectId');
  const analysisProvider = requiredText(config.analysis?.provider, 'analysis.provider');
  const analysisModel = requiredText(config.analysis?.model, 'analysis.model');
  const answerProvider = requiredText(config.answer?.provider, 'answer.provider');
  const answerModel = requiredText(config.answer?.model, 'answer.model');
  const maxCalls = config.budget?.maxCallsPerDay;
  const maxTokens = config.budget?.maxTokensPerDay;
  if (!maxCalls || maxCalls <= 0 || !maxTokens || maxTokens <= 0) throw new Error('budget.maxCallsPerDay and budget.maxTokensPerDay must be positive.');
  if (config.budget?.maxUsd !== undefined) throw new Error('maxUsd price accounting is unsupported without an explicit price table.');
  return {
    workspace, projectId,
    analysis: { provider: analysisProvider, model: analysisModel },
    answer: { provider: answerProvider, model: answerModel },
    budget: { maxCallsPerDay: maxCalls, maxTokensPerDay: maxTokens },
    ...(config.deadlineMs ? { deadlineMs: config.deadlineMs } : {}),
  };
};

export const assertCases = (cases: readonly CompareCase[]): readonly CompareCase[] => {
  if (!cases.length) throw new Error('cases must not be empty.');
  return cases;
};

export const assertEmptyWorkspace = async (workspace: string): Promise<void> => {
  const entries = await readdir(workspace).catch(() => {
    throw new Error('workspace must exist and be empty.');
  });
  if (entries.length) throw new Error('workspace must be a new empty directory.');
};

const fileBytes = async (path: string): Promise<number> => (await stat(path).catch(() => undefined))?.size ?? 0;

const walkBytes = async (root: string, match: (name: string) => boolean): Promise<number> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const totals = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walkBytes(path, match);
    return match(entry.name) ? fileBytes(path) : 0;
  }));
  return totals.reduce((sum, value) => sum + value, 0);
};

export const measureMemoryStore = async (root: string): Promise<CompareReport['storage']> => {
  const sqlite = join(root, MEMORY_DATABASE);
  return {
    sqliteBytes: await fileBytes(sqlite),
    walBytes: await fileBytes(`${sqlite}-wal`),
    shmBytes: await fileBytes(`${sqlite}-shm`),
    journalBytes: await walkBytes(root, name => name.endsWith('.jsonl')),
    checkpointBytes: await walkBytes(root, name => name.startsWith('checkpoint') || name.includes('checkpoint')),
  };
};

const percentile = (samples: readonly number[], p: number): number => {
  if (!samples.length) return 0;
  const ordered = [...samples].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((p / 100) * ordered.length) - 1));
  return ordered[index]!;
};

const missingFrom = (haystack: string, needles: readonly string[]): string[] =>
  needles.filter(needle => !haystack.toLowerCase().includes(needle.toLowerCase()));

/** Diagnostics only. Never used as PASS. Citations must appear in the answer. */
export const diagnose = (answer: string, kase: CompareCase, condition: CompareCondition): Diagnostics => ({
  missingRequired: missingFrom(answer, kase.required),
  unsupported: (kase.excluded ?? []).filter(item => answer.toLowerCase().includes(item.toLowerCase())),
  missingCitations: missingFrom(answer, kase.citations ?? []),
  missingConditions: (kase.conditions ?? COMPARE_CONDITIONS).includes(condition) ? [] : [condition],
});

export const runComparison = async (input: Readonly<{
  config: CompareConfig;
  cases: readonly CompareCase[];
  pack: (query: string) => EvidencePack | Promise<EvidencePack>;
  answer: AnswerProvider;
  memoryRoot?: string;
  signal?: AbortSignal;
}>): Promise<CompareReport> => {
  const config = assertCompareConfig(input.config);
  const cases = assertCases(input.cases);
  if (input.answer.provider !== config.answer.provider || input.answer.model !== config.answer.model) {
    throw new Error('Answer provider/model must match the configured answer model for every condition.');
  }
  const spend = { calls: 0, inputTokens: 0, outputTokens: 0, failedCalls: 0 };
  const samples: number[] = [];
  const reports: CaseReport[] = [];
  const deadline = config.deadlineMs ? AbortSignal.timeout(config.deadlineMs) : undefined;
  const signal = input.signal && deadline ? AbortSignal.any([input.signal, deadline]) : input.signal ?? deadline;
  for (const kase of cases) {
    const pack = await input.pack(kase.query);
    const evidenceByCondition: Record<CompareCondition, string> = {
      'evidence-complete': pack.evidenceComplete,
      'previous-document': pack.previousDocument,
      'curated-memory': pack.curatedMemory,
    };
    const wanted = new Set((kase.conditions ?? COMPARE_CONDITIONS) as CompareCondition[]);
    for (const condition of COMPARE_CONDITIONS) {
      if (!wanted.has(condition)) continue;
      const evidence = evidenceByCondition[condition];
      const estimate = Math.ceil((kase.query.length + evidence.length + pack.priorFacts.join(' ').length) / 4);
      spend.calls += 1;
      if (spend.calls > config.budget.maxCallsPerDay || spend.inputTokens + spend.outputTokens + estimate > config.budget.maxTokensPerDay) {
        throw new Error('budget_exhausted');
      }
      const t0 = Date.now();
      const answered = await input.answer.answer({
        query: kase.query, evidence, condition, priorFacts: pack.priorFacts,
      }, signal).catch((): AnswerResult => ({ text: '', inputTokens: estimate, outputTokens: 0, failed: true }));
      samples.push(Date.now() - t0);
      spend.inputTokens += answered.inputTokens;
      spend.outputTokens += answered.outputTokens;
      if (answered.failed) spend.failedCalls += 1;
      reports.push({
        name: kase.name, condition, answer: answered.text,
        diagnostics: diagnose(answered.text, kase, condition),
        adjudication: 'unreviewed',
      });
    }
  }
  const storage = input.memoryRoot
    ? await measureMemoryStore(input.memoryRoot)
    : { sqliteBytes: 0, walBytes: 0, shmBytes: 0, journalBytes: 0, checkpointBytes: 0 };
  const emptyStorage = !input.memoryRoot;
  return {
    status: 'unreviewed',
    reason: emptyStorage
      ? 'Storage measurements absent; substring diagnostics are not semantic PASS.'
      : 'Substring diagnostics are not semantic PASS; adjudication remains UNREVIEWED without an authorized judge.',
    analysis: config.analysis,
    answer: config.answer,
    spend,
    storage,
    latencyMs: {
      samples, cold: samples[0] ?? 0, warm: samples.length > 1 ? samples[1]! : 0, p95: percentile(samples, 95),
    },
    cases: reports,
    passed: false,
  };
};
