import { isCuratedNamespace } from '../curation/types.ts';
import type { MemoryEngine } from '../engine.ts';
import type { EvidencePack } from './comparison.ts';

export const packEvidence = async (engine: MemoryEngine, query: string): Promise<EvidencePack> => {
  const facts = engine.projection.activeFacts(engine.scopeId, 1000);
  const priorFacts = facts.map(fact => fact.statement);
  const evidenceComplete = facts.map(fact => {
    const excerpts = fact.evidence.map(item => item.excerpt).join(' | ');
    return `${fact.statement}${excerpts ? ` [${excerpts}]` : ''}`;
  }).join('\n');
  const previousDocument = [...engine.projection.eachActiveDocument()]
    .filter(document => !isCuratedNamespace(document.namespace))
    .map(document => `${document.title ?? document.externalId}\n${document.text.slice(0, 4000)}`)
    .join('\n\n');
  const recalled = await engine.search({ queries: [query], dense: false, namespaces: ['memory', 'memory.topic'], limit: 8, maxBytes: 4096 });
  const curatedMemory = recalled.items.map(item => item.statement).join('\n');
  return { evidenceComplete, previousDocument, curatedMemory, priorFacts };
};
