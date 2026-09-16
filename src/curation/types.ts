import type { MemoryKind, MemoryStanding, TemporalFact } from '../contracts/memory.ts';

export const CURATED_NAMESPACES = ['memory', 'memory.topic'] as const;
export type CuratedNamespace = (typeof CURATED_NAMESPACES)[number];

export const JOB_ACTIONS = ['analyze', 'withdraw', 'review'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export const JOB_STATUSES = ['pending', 'claimed', 'published', 'failed', 'discarded', 'no_change', 'blocked'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const EPISTEMICS = ['decision', 'proposal', 'hypothesis', 'correction', 'conflict', 'procedure', 'constraint'] as const;
export type Epistemic = (typeof EPISTEMICS)[number];

export const ANALYSIS_ACTIONS = ['keep', 'create', 'revise', 'supersede', 'discard'] as const;
export type AnalysisAction = (typeof ANALYSIS_ACTIONS)[number];

export type SourceIdentity = Readonly<{
  adapter: string;
  documentKey: string;
  namespace: string;
  externalId: string;
  revision: string;
  contentHash: string;
  kind: string;
  title?: string;
  uri?: string;
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  trust: 'host' | 'user' | 'agent' | 'imported';
  metadata: Readonly<Record<string, string>>;
}>;

export type CurationJob = Readonly<{
  id: string;
  scopeId: string;
  adapter: string;
  documentKey: string;
  action: JobAction;
  status: JobStatus;
  inputRevision: string;
  contentHash: string;
  topicRevision?: string;
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  nextAttemptAt: number;
  errorCode?: string;
  errorDetail?: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  outputRevision?: string;
}>;

export type SourceRef = Readonly<{
  adapter: string;
  namespace: string;
  externalId: string;
  revision: string;
  locator?: string;
  observedAt: string;
}>;

export type ProposedFact = Readonly<{
  action: AnalysisAction;
  id?: string;
  kind: MemoryKind;
  epistemic: Epistemic;
  statement: string;
  confidence: number;
  standing: MemoryStanding;
  subject?: string;
  predicate?: string;
  object?: string;
  validAt?: string;
  invalidAt?: string;
  supersedes?: readonly string[];
  semanticKey: string;
  sourceRefs: readonly SourceRef[];
  excerpt: string;
}>;

export type ProposedTopic = Readonly<{
  id: string;
  title: string;
  summary: string;
}>;

export type AnalysisProposal = Readonly<{
  noChange: boolean;
  topic?: ProposedTopic;
  facts: readonly ProposedFact[];
  conflicts: readonly string[];
}>;

export type LivingContext = Readonly<{
  goal: string;
  constraints: readonly string[];
  done: readonly string[];
  inProgress: readonly string[];
  blocked: readonly string[];
  decisions: readonly string[];
  evidenceRefs: readonly string[];
  nextSteps: readonly string[];
}>;

export type EvidenceBundle = Readonly<{
  identity: SourceIdentity;
  text: string;
  truncated: boolean;
  window?: Readonly<{ offset: number; end: number; total: number }>;
  currentTopic?: Readonly<{ id: string; revision: number; summary: string }>;
  currentFacts: readonly TemporalFact[];
  livingContext?: LivingContext;
}>;

export type AnalysisUsage = Readonly<{ inputTokens: number; outputTokens: number; calls: number }>;

export type AnalysisResult = Readonly<{
  proposal: AnalysisProposal;
  usage: AnalysisUsage;
  model: string;
  provider: string;
}>;

export interface Analyzer {
  readonly provider: string;
  readonly model: string;
  analyze(bundle: EvidenceBundle, signal?: AbortSignal): Promise<AnalysisResult>;
  synthesize?(bundle: EvidenceBundle, signal?: AbortSignal): Promise<AnalysisResult>;
}

export type Spend = Readonly<{
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  embeddingCalls: number;
}>;

export type CurationStats = Readonly<{
  fingerprints: number;
  pending: number;
  claimed: number;
  failed: number;
  blocked: number;
  published: number;
  spend: Spend;
}>;

export type Budget = Readonly<{
  maxCallsPerDay: number;
  maxTokensPerDay: number;
}>;

export class CurationBlockError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const isCuratedNamespace = (namespace: string): boolean =>
  (CURATED_NAMESPACES as readonly string[]).includes(namespace);
