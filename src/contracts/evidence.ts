export type EvidenceOrigin = 'host_observation' | 'user_statement' | 'agent_report' | 'imported_source';
export type EvidenceProvenance = 'native_observation' | 'declared' | 'agent_report' | 'imported';

export type EvidenceRef = Readonly<{
  id: string;
  origin: EvidenceOrigin;
  provenance: EvidenceProvenance;
  uri?: string;
  contentHash: string;
  excerpt: string;
  observedAt: string;
  actorId?: string;
  sessionId?: string;
  toolCallId?: string;
}>;

export const assertEvidence = (evidence: EvidenceRef): EvidenceRef => {
  if (!/^ev_[a-z0-9_-]{8,64}$/.test(evidence.id)) throw new Error('Invalid evidence id.');
  if (!/^[0-9a-f]{64}$/.test(evidence.contentHash)) throw new Error('Evidence contentHash must be SHA-256.');
  if (!evidence.excerpt.trim() || Buffer.byteLength(evidence.excerpt, 'utf8') > 8192) throw new Error('Evidence excerpt must be 1–8192 bytes.');
  if (!Number.isFinite(Date.parse(evidence.observedAt))) throw new Error('Evidence observedAt must be ISO-8601.');
  if (evidence.provenance === 'native_observation' && evidence.origin !== 'host_observation') {
    throw new Error('Native observation provenance is host-derived.');
  }
  return evidence;
};

export const evidenceStanding = (evidence: readonly EvidenceRef[]): 'supported' | 'needs_review' =>
  evidence.some(item => item.provenance === 'native_observation' || item.provenance === 'declared')
    ? 'supported'
    : 'needs_review';
