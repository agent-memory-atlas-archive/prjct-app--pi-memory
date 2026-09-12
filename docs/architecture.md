# Architecture

## Pi is the engine

pi-memory follows the pi-team extension pattern. It registers tools, commands,
renderers, and documented lifecycle hooks in the Pi process. It starts no MCP
server, daemon, graph database, or child reasoning process and never calls a
second LLM behind the current agent.

The active agent performs the cognitive work:

1. turn a task into up to four standalone retrieval queries;
2. rerank returned candidates against the actual task and inspect evidence;
3. extract only durable knowledge and choose entities and temporal bounds;
4. decide whether related facts duplicate, contradict, or supersede one another;
5. compose the final context or answer.

The extension performs mechanical work: provenance enforcement, hashing,
chunking, embedding, BM25/KNN lookup, temporal filtering, graph adjacency,
storage, byte budgets, and garbage collection. The embedding encoder only maps
text to numbers; it cannot promote a claim or decide what is true.

## Scope and identity

`src/workspace/project-identity.ts` deliberately copies prjct's pure identity
rule. The `.prjct/prjct.config.json` locator wins when a checkout moved;
otherwise the id is `p_` plus the first twelve hexadecimal characters of
SHA-256 over its canonical path. No extension needs another installed to agree
on these roots:

- project: `$PRJCT_HOME/<projectId>/memory`
- team: `$PRJCT_HOME/teams/<teamId>/memory`
- shared: `$PRJCT_HOME/shared/memory`

The old sibling `vector/` component is not used. `src/vector/` is a public module
inside the pi-memory npm package.

## Authoritative log and projection

Every durable mutation first appends one bounded `MemoryEvent` to
`events/<UTC-day>/<writerId>.jsonl`. Writers are unique to a session runtime, so
independent Pi processes never append to the same file. Each stream is monotonic
and hash-chained. Files are opened with append, create, write, and no-follow
flags and synced before the event is projected.

A crash after append but before projection leaves recoverable work. `replay()`
finds unapplied event ids; `rebuild()` discards SQLite and applies the complete
log. A malformed or torn event fails closed rather than being skipped.

`index.sqlite` uses WAL, foreign keys, a busy timeout, and incremental vacuum. It
contains:

- source documents and deterministic chunks;
- FTS5 rows for lexical retrieval;
- sqlite-vec collections keyed by `(model, dimensions)`;
- episodes, evidence, entities, temporal facts, links, and usefulness signals;
- applied event ids for idempotent replay.

There is no mutable JSON snapshot and no revision directory. Historical truth is
represented by events, not copies of the whole state.

## Provenance and time

An `EvidenceRef` distinguishes host observation, exact user statement, agent
report, and imported source. Credential-shaped text is redacted before source
content or evidence enters the journal. Only a `tool_result` hook can construct
`native_observation`; tool arguments cannot. A user declaration must quote text
from the current prompt exactly. Agent-only facts remain `needs_review` unless
later supported.

Facts carry valid time (`validAt`, `invalidAt`) and transaction time
(`recordedAt`, `expiredAt`). Superseding or contradicting a fact appends a
resolution event, sets its terminal standing, and closes its valid interval
without erasing it. Historical `asOf` retrieval may still return the earlier
fact when the query time falls inside that interval.

## Vector indexing

The default provider lazily loads the
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` feature-extraction pipeline with
q8 model weights and mean-pooled normalized embeddings. Model files are cached
under the shared memory scope. A configured OpenAI-compatible endpoint implements
the same `EmbeddingProvider` contract.

Vectors are scalar-quantized into sqlite-vec `int8` collections, reducing vector
storage fourfold relative to Float32. Model name and dimensions select a
separate collection; old collections are rebuildable and GC removes them after a
provider change. The lexical chunks are committed before embedding, so a cold
model download or provider outage yields explicit partial service rather than a
silent empty index.

## Retrieval

`hybridSearch` evaluates up to four active-agent query expansions through three
independent legs:

1. exact id, path, URI, and substring matches;
2. FTS5 BM25;
3. dense sqlite-vec KNN.

Weighted reciprocal-rank fusion combines incomparable ranks. Evidence trust,
fact confidence, and observed usefulness provide bounded priors. Valid-time and
standing filters run before output. One adjacency hop over shared entities adds
related temporal facts; lexical overlap and per-source caps remove redundant
candidates. The final list is serialized under a caller-supplied hard byte
budget and reports omissions and unavailable legs.

`before_agent_start` runs lexical-only retrieval over the raw prompt and adds at
most four high-confidence candidates to that turn's system prompt. It does not
append a persistent session message or block startup on a model download. The
agent calls `memory_context` when semantic expansion is warranted.

## Selective capture

The host stages a bounded window of tool results, excluding memory's own tools,
to the newest 64 and appends the resulting evidence id to the tool result seen by
the active agent. Staging is not memory and disappears with the session.
`memory_record` promotes evidence only when the active agent identifies a
reusable decision, correction, constraint, preference, failure, or procedure.
Routine reads and progress are never automatically vectorized.

`SourceAdapter` is the application-neutral ingress boundary. The built-in prjct
adapter reads its observation records, and the pi-team adapter reads settled
journal threads plus content-addressed artifacts. Both communicate through files
and contracts, not package imports.

## Consolidation and garbage collection

Mechanical token overlap only proposes consolidation candidates; it never
changes standing. The active agent must append the supersession or contradiction
resolution.

Retention value combines evidence, judgment type, actual positive/negative use,
age, and standing. Novelty alone is not value. Supported user/native decisions,
corrections, constraints, and preferences are protected. GC marks active document
roots, removes only unreferenced or low-value hot projections and stale vector
collections, records the removed keys in a `gc.compacted` event, and incrementally
vacuums SQLite. Facts and evidence remain replayable from the append-only log.

## Quality gates

The gold suite covers paraphrases, bilingual queries, temporal policy, failures,
constraints, and query expansion. Every retrieval change is compared on the same
corpus against BM25, the former feature-hash semantic leg, and old-style RRF.
Acceptance requires at least +20% relative nDCG@10 over the best baseline with no
Recall@10 or MRR regression.

The synthetic warm-index benchmark reports write time, p50/p95 KNN latency, and
bytes per chunk at 100,000 chunks and 1,000 queries. Cold model download and
provider network time are deliberately reported separately from SQLite query
latency.

## Boundaries

Local disks on macOS and Linux are supported. Network filesystems, cross-machine
replication, native Windows, unbounded binary ingestion, autonomous community
summarization, and automatic truth decisions are not.
