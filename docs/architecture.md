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
most four candidates above the documented automatic-injection threshold
(`scoreThreshold: 0.055`) to that turn's system prompt. It does not append a
persistent session message or block startup on a model download. The agent calls
`memory_context` when semantic expansion is warranted.

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

`/memory rebuild` is an operator action for a quiet scope. It uses an advisory
lock against another rebuild, builds the replacement SQLite file beside the live
projection, and swaps it only after the full journal has applied. It cannot
fence another already-open Pi process that keeps writing during the swap; any
such writes remain in the append-only journal and are recovered by a later
replay or rebuild.

## Quality gates

The gold suite is 113 documents and 42 queries. Documents are grouped into
topic clusters so that most of a cluster is a *distractor* sharing the target's
vocabulary, and several queries carry more than one correct answer. It covers
paraphrases, a bilingual query, temporal policy, failures and constraints.

The gate scores `candidateNoExpansion` — the system given only the user's query
— against the best score any baseline achieved on each metric, where the
baselines are BM25, the former feature-hash semantic leg, and old-style RRF.
Acceptance requires at least +20% relative nDCG@10 with no Recall@10 or MRR
regression.

Scoring the no-expansion run is deliberate. Query expansions in the fixture are
written by hand, so a gate that scores the run *with* them measures how closely
the fixture author paraphrased the answer. An earlier version of this suite did
exactly that and reported nDCG@10 = 1.0000; its expansions repeated the target
document nearly verbatim, and the system scored 0.8216 without them against a
0.8623 bar. The current expansions restate the *question*, never the answer, and
are worth about +0.007 — which is roughly what an honest expansion is worth on a
corpus this size.

The suite is a regression gate, not proof of broad retrieval quality. 42 queries
over 113 documents is small; it must grow with observed production failures.

The benchmark drives the real ingest path (`MemoryEngine.index` and
`indexAll`) over ~1.1 KB documents, with a deterministic stand-in encoder that
gives every chunk a distinct vector. It reports single-document and batched
ingest separately, KNN latency, whole-query latency, and bytes per chunk.
Encoder inference is deliberately near-free so the throughput figure is the cost
of the storage path; a real local encoder is orders of magnitude slower and
would dominate, so model time is measured separately and never folded in.

An earlier benchmark bypassed the engine, wrote through projection methods that
nothing else used, and stored the identical one-hot vector for all 100,000
chunks against 22-byte documents. Its numbers described none of the above.

## Boundaries

Local disks on macOS and Linux are supported. Network filesystems, cross-machine
replication, native Windows, unbounded binary ingestion, autonomous community
summarization, and automatic truth decisions are not.
