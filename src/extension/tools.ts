import { randomUUID } from 'node:crypto';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { EvidenceRef } from '../contracts/evidence.ts';
import { factIsValidAt, type MemoryKind, type MemoryStanding } from '../contracts/memory.ts';
import type { MemoryEngine } from '../engine.ts';
import type { MemorySearch } from './hooks.ts';
import { admitCapture } from '../retention/capture-gate.ts';
import { consolidationCandidates } from '../retention/consolidation.ts';
import { sha256 } from '../workspace/project-identity.ts';
import { renderMemoryCall, renderMemoryResult } from './renderers.ts';

export type ExtensionMemoryRuntime = Readonly<{
  /** The project scope: what memory_record writes to. */
  engine(): Promise<MemoryEngine>;
  /** Engines belonging to the active project; production currently returns one. */
  readable(): Promise<readonly MemoryEngine[]>;
  /** Project-local lookup across eligible ranking legs. */
  search: MemorySearch;
  stagedEvidence(): ReadonlyMap<string, EvidenceRef>;
  currentPrompt(): string;
}>;

const kinds = ['decision', 'fact', 'constraint', 'failure', 'correction', 'procedure', 'preference', 'learning'] as const;
const standings = ['candidate', 'supported', 'needs_review', 'contradicted', 'superseded'] as const;

const contextParameters = Type.Object({
  action: StringEnum(['lookup', 'inspect', 'feedback', 'consolidate'] as const),
  queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 4 })),
  ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 32 })),
  asOf: Type.Optional(Type.String({ maxLength: 64 })),
  namespaces: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  kinds: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  signal: Type.Optional(StringEnum(['used', 'helpful'] as const)),
  maxBytes: Type.Optional(Type.Integer({ minimum: 512, maximum: 32768 })),
}, { additionalProperties: false });

const recordParameters = Type.Object({
  action: StringEnum(['remember', 'resolve'] as const),
  kind: Type.Optional(StringEnum(kinds)),
  statement: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  subject: Type.Optional(Type.String({ maxLength: 512 })),
  predicate: Type.Optional(Type.String({ maxLength: 256 })),
  object: Type.Optional(Type.String({ maxLength: 1024 })),
  entities: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), type: Type.String({ minLength: 1, maxLength: 64 }), aliases: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 })) }, { additionalProperties: false }), { maxItems: 24 })),
  evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 32 })),
  userQuote: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  validAt: Type.Optional(Type.String({ maxLength: 64 })),
  invalidAt: Type.Optional(Type.String({ maxLength: 64 })),
  supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 32 })),
  tags: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 512 }))),
  factId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  standing: Type.Optional(StringEnum(standings)),
  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  replacementId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

const normalized = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const compactItem = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  const statement = typeof item.statement === 'string' ? item.statement : undefined;
  const title = typeof item.title === 'string' ? item.title : undefined;
  const includeTitle = title && statement && !normalized(statement).startsWith(normalized(title));
  return {
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
    ...(typeof item.kind === 'string' ? { type: item.kind } : typeof item.namespace === 'string' ? { type: item.namespace } : {}),
    ...(typeof item.standing === 'string' ? { standing: item.standing } : {}),
    ...(includeTitle ? { title } : {}), ...(statement ? { statement } : {}),
    ...(typeof item.observedAt === 'string' ? { observedAt: item.observedAt } : {}),
    ...(typeof item.validAt === 'string' ? { validAt: item.validAt } : {}),
    ...(typeof item.invalidAt === 'string' ? { invalidAt: item.invalidAt } : {}),
    ...(typeof item.score === 'number' ? { score: Number(item.score.toFixed(4)) } : {}),
  };
};
const compactView = (details: unknown): unknown => {
  if (!details || typeof details !== 'object') return details;
  const value = details as Record<string, unknown>;
  if (!Array.isArray(value.items)) return details;
  return { status: value.status, items: value.items.map(compactItem),
    ...(typeof value.omitted === 'number' ? { omitted: value.omitted } : {}),
    ...(Array.isArray(value.gaps) && value.gaps.length ? { gaps: value.gaps } : {}) };
};
const result = (details: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(compactView(details)) }], details });
const required = (value: string | undefined, name: string): string => {
  if (!value?.trim()) throw new Error(`${name} is required for this action.`);
  return value;
};
const words = (text: string): Set<string> => new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
  .filter(word => !['the', 'and', 'for', 'that', 'this', 'with', 'from', 'para', 'con', 'una', 'por'].includes(word)));
const related = (left: string, right: string): boolean => {
  const rightWords = words(right);
  return [...words(left)].filter(word => rightWords.has(word)).length >= 2;
};
const verifiedQuote = (quote: string | undefined, prompt: string, statement: string): string | undefined => {
  const value = quote?.trim();
  if (!value) return undefined;
  if (value.length < 12 || words(value).size < 3) throw new Error('userQuote must contain at least 12 characters and three content words.');
  if (!prompt.includes(value)) throw new Error('userQuote must occur exactly in the current user prompt.');
  if (!related(value, statement)) throw new Error('userQuote must be related to the memory statement.');
  return value;
};
const RESERVED_TAGS = new Set(['sourceDocumentKey', 'sourceRevision', 'sourceAdapter', 'topicId', 'semanticKey']);
const safeTags = (tags: Readonly<Record<string, string>> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(tags ?? {}).filter(([key]) => !RESERVED_TAGS.has(key)));

export const installMemoryTools = (pi: ExtensionAPI, runtime: ExtensionMemoryRuntime): void => {
  pi.registerTool({
    name: 'memory_context', label: 'Memory context',
    description: 'Search or inspect bounded project memory; consolidate exact candidates or record positive retrieval feedback.',
    parameters: contextParameters,
    async execute(_toolCallId, params, signal) {
      const engine = await runtime.engine();
      if (params.action === 'lookup') {
        return result(await runtime.search({ queries: params.queries ?? [],
          ...(params.asOf ? { asOf: params.asOf } : {}), namespaces: params.namespaces ?? ['memory', 'memory.topic'],
          ...(params.kinds ? { kinds: params.kinds } : {}), maxBytes: params.maxBytes ?? 1500,
          dense: true, signal }));
      }
      if (params.action === 'inspect') {
        const memory = await runtime.engine();
        const asOf = params.asOf ? Date.parse(params.asOf) : Date.now();
        if (!Number.isFinite(asOf)) throw new Error('asOf must be ISO-8601.');
        const maxBytes = params.maxBytes ?? 4096;
        const items: unknown[] = [];
        const gaps: string[] = [];
        for (const id of params.ids ?? []) {
          const fact = memory.projection.getFact(id);
          if (fact) {
            if (fact.scopeId !== memory.scopeId) { gaps.push(`${id} is not owned by this project.`); continue; }
            if (!factIsValidAt(fact, asOf)) { gaps.push(`${id} is not valid at asOf.`); continue; }
            items.push(fact);
            continue;
          }
          const topic = memory.projection.documentByKey({ namespace: 'memory.topic', externalId: id });
          if (!topic || topic.scopeId !== memory.scopeId) { gaps.push(`No requested memory ids exist for ${id}.`); continue; }
          const facts = (topic.metadata.facts ?? '').split(',').filter(Boolean).flatMap(factId => {
            const found = memory.projection.getFact(factId);
            return found && found.scopeId === memory.scopeId && factIsValidAt(found, asOf) ? [found] : [];
          });
          items.push({ id: topic.externalId, title: topic.title, statement: topic.text, facts, sources: topic.metadata.sources });
        }
        const packed = { status: items.length ? 'ok' : 'abstained', items, gaps };
        const encoded = JSON.stringify(packed);
        if (Buffer.byteLength(encoded) <= maxBytes) return result(packed);
        const clipped = { status: 'partial' as const, items: items.slice(0, 1), gaps: [...gaps, 'inspect exceeded maxBytes; returned the first topic or fact.'] };
        return result(clipped);
      }
      if (params.action === 'consolidate') {
        const candidates = consolidationCandidates(engine.projection.activeFacts(engine.scopeId));
        return result({ status: candidates.length ? 'ok' : 'abstained', candidates,
          gaps: candidates.length ? [] : ['No mechanical consolidation candidates were found.'] });
      }
      if (!params.signal || !(params.ids?.length)) throw new Error('feedback requires ids and signal.');
      const memory = await runtime.engine();
      const query = (params.queries ?? []).join('\n');
      const applied = { count: 0 };
      const missing: string[] = [];
      for (const id of params.ids) {
        if (!memory.projection.getFact(id)) { missing.push(id); continue; }
        await memory.feedback(id, params.signal, query);
        applied.count += 1;
      }
      return result({ status: applied.count ? 'ok' : 'abstained', recorded: applied.count, signal: params.signal,
        gaps: missing.length ? [`No open scope holds ${missing.join(', ')}.`] : [] });
    },
    renderCall(args, theme) { return renderMemoryCall(theme.fg('accent', 'memory context'), args); },
    renderResult(output, options) { return renderMemoryResult('memory context', output.details, options.expanded); },
  });

  pi.registerTool({
    name: 'memory_record', label: 'Record memory',
    description: 'Record selective durable knowledge or resolve memory using current-session evidence handles or an exact user quote.',
    parameters: recordParameters,
    async execute(_toolCallId, params, signal) {
      const engine = await runtime.engine();
      if (params.action === 'resolve') {
        const factId = required(params.factId, 'factId');
        const fact = engine.projection.getFact(factId);
        if (!fact) throw new Error(`Unknown memory ${factId}.`);
        const standing = params.standing as MemoryStanding | undefined;
        if (!standing || !['supported', 'needs_review', 'contradicted', 'superseded'].includes(standing)) throw new Error('resolve requires a supported, review, or terminal standing.');
        const rationale = required(params.rationale, 'rationale');
        const evidence = (params.evidenceIds ?? []).map(id => {
          const found = runtime.stagedEvidence().get(id);
          if (!found) throw new Error(`Evidence ${id} was not observed by this session.`);
          return found;
        });
        const quote = verifiedQuote(params.userQuote, runtime.currentPrompt(), `${fact.statement} ${rationale}`);
        if (!quote && !evidence.some(item => related(item.excerpt, `${fact.statement} ${rationale}`))) {
          throw new Error('Resolving memory requires related current-session evidence or an exact user quote.');
        }
        await engine.resolveFact(factId, standing, rationale, params.replacementId);
        return result({ status: 'ok', factId, standing });
      }
      const statement = required(params.statement, 'statement');
      const admission = admitCapture({
        statement, kind: params.kind ?? 'learning',
        existing: engine.projection.activeFacts(engine.scopeId, 200).map(item => ({ statement: item.statement, kind: item.kind })),
      });
      if (!admission.accept) return result({ status: 'abstained', gaps: [`Capture refused: ${admission.reason}.`] });
      const staged = runtime.stagedEvidence();
      const evidence = (params.evidenceIds ?? []).map(id => {
        const found = staged.get(id);
        if (!found) throw new Error(`Evidence ${id} was not observed by this session.`);
        return found;
      });
      const quote = verifiedQuote(params.userQuote, runtime.currentPrompt(), statement);
      const evidenceRelated = evidence.every(item => related(item.excerpt, statement));
      const allEvidence: EvidenceRef[] = [...evidence, ...(quote ? [{ id: `ev_${randomUUID()}`, origin: 'user_statement' as const,
        provenance: 'declared' as const, contentHash: sha256(quote), excerpt: quote, observedAt: new Date().toISOString() }] : [])];
      const entities = (params.entities ?? []).map(entity => ({ id: `ent_${sha256(`${engine.scopeId}\u0000${entity.type}\u0000${entity.name.toLocaleLowerCase()}`).slice(0, 24)}`,
        scopeId: engine.scopeId, name: entity.name, type: entity.type, aliases: entity.aliases ?? [] }));
      const recorded = await engine.recordFact({ kind: (params.kind ?? 'learning') as MemoryKind, statement,
        ...(params.subject ? { subject: params.subject } : {}), ...(params.predicate ? { predicate: params.predicate } : {}),
        ...(params.object ? { object: params.object } : {}), entities, evidence: allEvidence, episodeIds: [],
        confidence: params.confidence ?? (allEvidence.length ? 0.85 : 0.5), ...(params.validAt ? { validAt: params.validAt } : {}),
        ...(params.invalidAt ? { invalidAt: params.invalidAt } : {}), ...(params.supersedes ? { supersedes: params.supersedes } : {}),
        ...(!evidenceRelated && !quote ? { standing: 'needs_review' as const } : {}), tags: safeTags(params.tags) }, signal);
      return result({ status: recorded.dense ? 'ok' : 'partial', id: recorded.fact.id, standing: recorded.fact.standing,
        dense: recorded.dense, gaps: recorded.dense ? [] : ['Dense indexing deferred; memory and lexical index committed.'] });
    },
    renderCall(args, theme) { return renderMemoryCall(theme.fg('accent', 'memory record'), args); },
    renderResult(output, options) { return renderMemoryResult('memory record', output.details, options.expanded); },
  });
};
