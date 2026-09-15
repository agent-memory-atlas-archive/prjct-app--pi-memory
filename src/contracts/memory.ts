import type { EvidenceRef } from './evidence.ts';

export type MemoryKind = 'decision' | 'fact' | 'constraint' | 'failure' | 'correction' | 'procedure' | 'preference' | 'learning';
export type MemoryStanding = 'candidate' | 'supported' | 'needs_review' | 'contradicted' | 'superseded';

export type Episode = Readonly<{
  id: string;
  scopeId: string;
  kind: MemoryKind;
  summary: string;
  observedAt: string;
  actorId?: string;
  sessionId?: string;
  source: string;
  evidence: readonly EvidenceRef[];
}>;

export type Entity = Readonly<{
  id: string;
  scopeId: string;
  name: string;
  type: string;
  aliases: readonly string[];
  summary?: string;
}>;

export type TemporalFact = Readonly<{
  id: string;
  scopeId: string;
  kind: MemoryKind;
  statement: string;
  subject?: string;
  predicate?: string;
  object?: string;
  entities: readonly Entity[];
  evidence: readonly EvidenceRef[];
  episodeIds: readonly string[];
  standing: MemoryStanding;
  confidence: number;
  validAt?: string;
  invalidAt?: string;
  recordedAt: string;
  expiredAt?: string;
  supersedes?: readonly string[];
  tags: Readonly<Record<string, string>>;
}>;

export const assertTemporalFact = (fact: TemporalFact): TemporalFact => {
  if (!/^mem_[a-z0-9_-]{8,64}$/.test(fact.id)) throw new Error('Invalid memory id.');
  if (!fact.statement.trim() || Buffer.byteLength(fact.statement, 'utf8') > 8192) throw new Error('Memory statement must be 1–8192 bytes.');
  if (fact.confidence < 0 || fact.confidence > 1) throw new Error('Memory confidence must be between 0 and 1.');
  if (!Number.isFinite(Date.parse(fact.recordedAt))) throw new Error('Memory recordedAt must be ISO-8601.');
  if (fact.validAt !== undefined && !Number.isFinite(Date.parse(fact.validAt))) throw new Error('Memory validAt must be ISO-8601.');
  if (fact.invalidAt !== undefined && !Number.isFinite(Date.parse(fact.invalidAt))) throw new Error('Memory invalidAt must be ISO-8601.');
  if (fact.expiredAt !== undefined && !Number.isFinite(Date.parse(fact.expiredAt))) throw new Error('Memory expiredAt must be ISO-8601.');
  if (fact.validAt && fact.invalidAt && Date.parse(fact.validAt) >= Date.parse(fact.invalidAt)) throw new Error('Memory validAt must precede invalidAt.');
  if (fact.entities.length > 24 || fact.evidence.length > 32 || fact.episodeIds.length > 32 || (fact.supersedes?.length ?? 0) > 32) {
    throw new Error('Memory relationship limit exceeded.');
  }
  if (Object.keys(fact.tags).length > 64 || Object.entries(fact.tags).some(([key, value]) => key.length > 64 || value.length > 512)) {
    throw new Error('Memory tags exceed their bounds.');
  }
  return fact;
};

export const factIsValidAt = (fact: Pick<TemporalFact, 'standing' | 'validAt' | 'invalidAt' | 'recordedAt'>, asOf: number): boolean => {
  const starts = Date.parse(fact.validAt ?? fact.recordedAt);
  const ends = fact.invalidAt ? Date.parse(fact.invalidAt) : Number.POSITIVE_INFINITY;
  const terminalWithoutHistory = (fact.standing === 'contradicted' || fact.standing === 'superseded') && !fact.invalidAt;
  return !terminalWithoutHistory && starts <= asOf && asOf < ends;
};
