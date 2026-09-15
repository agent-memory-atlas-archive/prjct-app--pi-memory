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
  /** Every scope the session may read from. */
  readable(): Promise<readonly MemoryEngine[]>;
  /** Federated lookup across all readable scopes. */
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
  signal: Type.Optional(StringEnum(['used', 'helpful', 'wrong', 'stale'] as const)),
  maxBytes: Type.Optional(Type.Integer({ minimum: 512, maximum: 32768 })),
  scoreThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  dense: Type.Optional(Type.Boolean()),
  scopes: Type.Optional(Type.Array(StringEnum(['project', 'team', 'shared'] as const), { maxItems: 3 })),
}, { additionalProperties: false });

const recordParameters = Type.Object({
  action: StringEnum(['remember', 'resolve', 'index'] as const),
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
  namespace: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9._-]{0,63}$' })),
  externalId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  title: Type.Optional(Type.String({ maxLength: 512 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000000 })),
  uri: Type.Optional(Type.String({ maxLength: 4096 })),
  source: Type.Optional(Type.String({ maxLength: 128 })),
  documentKind: Type.Optional(Type.String({ maxLength: 128 })),
  metadata: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 512 }))),
}, { additionalProperties: false });

const result = (details: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details) }], details });
const required = (value: string | undefined, name: string): string => {
  if (!value?.trim()) throw new Error(`${name} is required for this action.`);
  return value;
};

export const installMemoryTools = (pi: ExtensionAPI, runtime: ExtensionMemoryRuntime): void => {
  pi.registerTool({
    name: 'memory_context', label: 'Memory context',
    description: 'Search, inspect, find mechanical consolidation candidates, or give feedback on temporal memory. Lookup searches only the active project memory; supply up to four standalone query expansions, and rerank the candidates against the task and evidence.',
    promptSnippet: 'Retrieve bounded temporal memory with hybrid lexical, vector and graph search',
    promptGuidelines: [
      'Use memory_context lookup with concise standalone query expansions when prior decisions, failures, preferences, or cross-session work could affect the answer.',
      'Treat memory_context items as evidence-ranked candidates: reject stale or irrelevant items, inspect important ids, and compose only what the current task needs.',
    ],
    parameters: contextParameters,
    async execute(_toolCallId, params, signal) {
      const engine = await runtime.engine();
      if (params.action === 'lookup') {
        if (params.scopes?.some(scope => scope !== 'project')) throw new Error('Memory search is project-local.');
        return result(await runtime.search({ queries: params.queries ?? [],
          ...(params.asOf ? { asOf: params.asOf } : {}), namespaces: params.namespaces ?? ['memory', 'memory.topic'],
          ...(params.kinds ? { kinds: params.kinds } : {}), maxBytes: params.maxBytes ?? 1500,
          ...(params.scoreThreshold !== undefined ? { scoreThreshold: params.scoreThreshold } : {}),
          dense: params.dense ?? true, signal }));
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
    description: 'Persist a selective memory, resolve an existing memory, or index a generic source document. The active Pi agent performs extraction and consolidation; the host enforces provenance and storage.',
    promptSnippet: 'Record durable decisions, corrections, failures, preferences, or source documents with evidence',
    promptGuidelines: [
      'Use memory_record only for reusable decisions, verified failures, corrections, stable constraints, procedures, or explicit user preferences—not routine reads or progress narration.',
      'When evidence is available, cite staged ev_ ids; use userQuote only for an exact statement in the current user prompt. Never claim native provenance yourself.',
      'Resolve obsolete memory with memory_record instead of rewriting history; supersession and contradiction are append-only temporal events.',
    ],
    parameters: recordParameters,
    async execute(_toolCallId, params, signal) {
      const engine = await runtime.engine();
      if (params.action === 'resolve') {
        const factId = required(params.factId, 'factId');
        const standing = params.standing as MemoryStanding | undefined;
        if (!standing || !['supported', 'needs_review', 'contradicted', 'superseded'].includes(standing)) throw new Error('resolve requires a terminal standing.');
        await engine.resolveFact(factId, standing, required(params.rationale, 'rationale'), params.replacementId);
        return result({ status: 'ok', factId, standing });
      }
      if (params.action === 'index') {
        const text = required(params.text, 'text');
        const now = new Date().toISOString();
        const indexed = await engine.index({ namespace: required(params.namespace, 'namespace'), externalId: required(params.externalId, 'externalId'),
          scopeId: engine.scopeId, scopeKind: engine.scopeKind,
          source: params.source ?? 'agent-indexed', kind: params.documentKind ?? 'document', ...(params.title ? { title: params.title } : {}), text,
          ...(params.uri ? { uri: params.uri } : {}), version: sha256(text), contentHash: sha256(text), observedAt: now,
          trust: 'agent', metadata: params.metadata ?? {} }, signal);
        return result({ status: indexed.dense ? 'ok' : 'partial', ...indexed, gaps: indexed.dense ? [] : ['Dense indexing deferred; lexical indexing committed.'] });
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
      const quote = params.userQuote?.trim();
      if (quote && !runtime.currentPrompt().includes(quote)) throw new Error('userQuote must occur exactly in the current user prompt.');
      const allEvidence: EvidenceRef[] = [...evidence, ...(quote ? [{ id: `ev_${randomUUID()}`, origin: 'user_statement' as const,
        provenance: 'declared' as const, contentHash: sha256(quote), excerpt: quote, observedAt: new Date().toISOString() }] : [])];
      const entities = (params.entities ?? []).map(entity => ({ id: `ent_${sha256(`${engine.scopeId}\u0000${entity.type}\u0000${entity.name.toLocaleLowerCase()}`).slice(0, 24)}`,
        scopeId: engine.scopeId, name: entity.name, type: entity.type, aliases: entity.aliases ?? [] }));
      const recorded = await engine.recordFact({ kind: (params.kind ?? 'learning') as MemoryKind, statement,
        ...(params.subject ? { subject: params.subject } : {}), ...(params.predicate ? { predicate: params.predicate } : {}),
        ...(params.object ? { object: params.object } : {}), entities, evidence: allEvidence, episodeIds: [],
        confidence: params.confidence ?? (allEvidence.length ? 0.85 : 0.5), ...(params.validAt ? { validAt: params.validAt } : {}),
        ...(params.invalidAt ? { invalidAt: params.invalidAt } : {}), ...(params.supersedes ? { supersedes: params.supersedes } : {}),
        tags: params.tags ?? {} }, signal);
      return result({ status: recorded.dense ? 'ok' : 'partial', id: recorded.fact.id, standing: recorded.fact.standing,
        dense: recorded.dense, gaps: recorded.dense ? [] : ['Dense indexing deferred; memory and lexical index committed.'] });
    },
    renderCall(args, theme) { return renderMemoryCall(theme.fg('accent', 'memory record'), args); },
    renderResult(output, options) { return renderMemoryResult('memory record', output.details, options.expanded); },
  });
};
