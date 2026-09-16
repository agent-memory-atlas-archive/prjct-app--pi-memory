import type { SourceDocument } from '../contracts/documents.ts';
import { sha256 } from '../workspace/project-identity.ts';

/** Fingerprint of identity, dates and metadata — never the body. */
export const sourceRevisionOf = (document: SourceDocument): string => {
  if (document.source === 'pi-session' && document.metadata.semanticKey && document.metadata.summaryHash) {
    return sha256(JSON.stringify({
      namespace: document.namespace, externalId: document.externalId, scopeId: document.scopeId,
      scopeKind: document.scopeKind, source: document.source, kind: document.kind, trust: document.trust,
      semanticKey: document.metadata.semanticKey, summaryHash: document.metadata.summaryHash,
      capture: document.metadata.capture,
    }));
  }
  return sha256(JSON.stringify({
    namespace: document.namespace, externalId: document.externalId, scopeId: document.scopeId,
    scopeKind: document.scopeKind, source: document.source, kind: document.kind, title: document.title,
    uri: document.uri, version: document.version, contentHash: document.contentHash,
    observedAt: document.observedAt, validFrom: document.validFrom, validTo: document.validTo,
    trust: document.trust,
    metadata: Object.fromEntries(Object.entries(document.metadata).sort(([left], [right]) => left.localeCompare(right))),
  }));
};

export const withSourceIdentity = (adapterId: string, document: SourceDocument): SourceDocument =>
  ({ ...document, sync: { adapter: adapterId, revision: sourceRevisionOf(document) } });
