export type ScopeKind = 'project' | 'team' | 'shared';

export type SourceDocument = Readonly<{
  namespace: string;
  externalId: string;
  scopeId: string;
  scopeKind: ScopeKind;
  source: string;
  kind: string;
  title?: string;
  text: string;
  uri?: string;
  version: string;
  contentHash: string;
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  trust: 'host' | 'user' | 'agent' | 'imported';
  metadata: Readonly<Record<string, string>>;
  /** Registry-owned revision and ownership, retained in the journal for safe reconciliation. */
  sync?: Readonly<{ adapter: string; revision: string }>;
}>;

export type DocumentChunk = Readonly<{
  id: string;
  documentKey: string;
  namespace: string;
  ordinal: number;
  text: string;
  contentHash: string;
  metadata: Readonly<Record<string, string>>;
}>;

export const documentKey = (document: Pick<SourceDocument, 'namespace' | 'externalId'>): string =>
  `${document.namespace}:${Buffer.from(document.externalId, 'utf8').toString('base64url')}`;

export const parseDocumentKey = (key: string): Pick<SourceDocument, 'namespace' | 'externalId'> => {
  const separator = key.indexOf(':');
  if (separator < 1) throw new Error('Invalid document key.');
  const namespace = key.slice(0, separator);
  const encodedId = key.slice(separator + 1);
  const externalId = Buffer.from(encodedId, 'base64url').toString('utf8');
  if (!encodedId || Buffer.from(externalId, 'utf8').toString('base64url') !== encodedId) throw new Error('Invalid document key.');
  return { namespace, externalId };
};

export const assertSourceDocument = (value: SourceDocument): SourceDocument => {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value.namespace)) throw new Error('Invalid document namespace.');
  if (!value.externalId.trim() || value.externalId.length > 512) throw new Error('Invalid external document id.');
  if (!value.scopeId.trim() || value.scopeId.length > 128) throw new Error('Invalid scope id.');
  if (!value.text.trim() || Buffer.byteLength(value.text, 'utf8') > 1_000_000) throw new Error('Document text must be 1–1,000,000 bytes.');
  if (!/^[0-9a-f]{64}$/.test(value.contentHash)) throw new Error('Document contentHash must be SHA-256.');
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new Error('Document observedAt must be ISO-8601.');
  for (const field of ['validFrom', 'validTo'] as const) {
    if (value[field] !== undefined && !Number.isFinite(Date.parse(value[field]))) throw new Error(`Document ${field} must be ISO-8601.`);
  }
  if (value.validFrom && value.validTo && Date.parse(value.validFrom) > Date.parse(value.validTo)) throw new Error('Document validFrom must not follow validTo.');
  if (value.sync && (!value.sync.adapter.trim() || value.sync.adapter.length > 256 || !/^[0-9a-f]{64}$/.test(value.sync.revision))) throw new Error('Invalid source sync identity.');
  if (Object.keys(value.metadata).length > 64) throw new Error('Document metadata is limited to 64 fields.');
  return value;
};
