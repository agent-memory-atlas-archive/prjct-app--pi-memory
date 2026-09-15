# Architecture

## Interactive extension and autonomous memory maintenance

The confirmed target separates interactive retrieval from an autonomous memory
analysis daemon. The daemon must maintain curated knowledge while Pi is closed;
a timer that runs only inside Pi does not meet that requirement. See
[curated memory and refresh jobs](curated-memory-plan.md#confirmed-execution-model-autonomous-daemon)
for the job contract and acceptance gates. The standalone daemon is
`scripts/memory-daemon.ts` (`once|start|stop|status|run`). Operational jobs live
in `curation.sqlite`. The following still describes the extension/storage substrate.

pi-memory follows the pi-team extension pattern. It registers tools, commands,
renderers, and documented lifecycle hooks in the Pi process. The extension starts
no MCP server, graph database or implicit daemon/model loop. Default source sync
fingerprints publishers and enqueues analysis; it does not copy raw bodies.

The active agent currently performs the cognitive work:

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
fact when the query time falls inside that interval. Without an explicit valid
start, the observation/recording date is the lower bound, not negative infinity.
All scopes in a search use the same query clock and half-open `[start, end)`
intervals. Empty intervals represent cancelled plans; malformed or inverted
source dates are rejected.

A fact that supersedes another closes it at the replacement's `validAt` (falling
back to its `recordedAt`); resolution transaction time comes from the journal.
Thus a future-effective replacement does not retire the current answer early.
Terminal intervals cannot be reopened in place: record a new fact so the gap in
validity is not erased. Fact ids are immutable. GC's seven-day grace starts no
earlier than both resolution time and the end of validity. Retrieval includes
observation, declared validity and resolution dates; automatic recall explicitly
warns that publication dates do not establish present applicability.

### Source freshness and retirement

JSON adapters map `validFrom` and `validTo` (custom field paths are supported).
Sync fingerprints include version, observation/validity dates and metadata, not
only body hashes. Metadata-only amendments therefore reach the projection and
journal. Schema v2 adds journal-recoverable source ownership and revision columns;
older projections migrate in place and re-sync to establish ownership.

A JSON adapter offers an authoritative snapshot in addition to `scan()`. Only a
complete snapshot may retire previously owned documents absent from it. A missing
root, missing blob, malformed JSON, invalid timestamps or failed indexing cannot
be interpreted as a withdrawal. Retained results report a source freshness gap;
a rebuild also reports unverified source state until a successful scan. Legacy
unowned rows are never guessed to belong to an adapter, and ordinary adapters
that only implement `scan()` remain additive. An adapter cannot overwrite another
adapter's tracked identity. Latest-per-id selection happens on raw revisions,
before content selection, so an excluded newer revision cannot resurrect an old
one. Ownership and tombstones survive rebuild.

These checks establish freshness only as of the last successful scan. They do
not infer semantic supersession between different document ids or filenames.
External documents retain the latest indexed revision, not a queryable version
archive: `asOf` applies its declared validity (or observation lower bound), and
cannot reconstruct deleted/overwritten source bodies. Facts retain their own
closed intervals until GC. Publisher writes should be atomic; a directory scan
is not a transactional snapshot of a publisher's entire store.

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

1. exact chunk-id and external-id lookups, plus a URI and substring scan for
   queries short enough to plausibly be a literal;
2. FTS5 BM25 over the twelve most selective terms of the query, chosen by
   document frequency;
3. dense sqlite-vec KNN.

None of the three joins the `documents` table. Deleting a document physically
removes its chunks, FTS rows and vectors, so there is no deleted row left to
filter out.

Weighted reciprocal-rank fusion combines incomparable ranks. Evidence trust,
fact confidence, and observed usefulness provide bounded priors. Valid-time and
standing filters run before output. One adjacency hop over shared entities adds
related temporal facts, subject to the same score threshold as everything else.
Lexical overlap removes redundant candidates, and a per-source cap applies only
when the candidates actually span more than one source — enforcing it in a
single-source scope just truncates the answer. The final list is serialized
under a caller-supplied hard byte budget.

`omitted` counts everything the limit, the diversity filter, or the byte budget
left out. `status` is narrower: `partial` means a retrieval leg failed or the
byte budget cut the answer short. Matching more than the limit is ordinary and
does not make an answer partial.

Retrieval is federated. The public lookup searches the session's project, teams,
and shared scope. It collects unfused candidates concurrently and applies
namespace, kind, scope and temporal eligibility before ranking. Filtered legs
replenish their candidate budget up to 1,000 hits; exhausting that bound reports
a gap rather than claiming complete recall.

Federated lexical scoring uses BM25 with one set of full-corpus document
frequencies and average length summed across scopes. It does not compare local
FTS5 magnitudes or derive IDF from the query's candidate pool. Titles contribute
alongside body text, common function words are removed, and named identifiers
found in titles/URIs constrain their query's candidates. The lexical quality is
normalized against the query's theoretical saturated BM25 score, not its best
observed hit. A weak corpus winner must not become a perfect match by definition.

The vector collection's `distance` is **L2 over quantized int8 values**, not
cosine. KNN still uses that existing collection; candidates additionally expose
cosine similarity computed on the stored vectors. Federated fusion uses this
similarity and refuses to compare different model/dimension spaces, returning
lexical results with a gap instead. No re-embedding is needed for this change.

One quality-weighted RRF combines the global lexical and cosine lists. Exact
ids, URIs and short literals get an explicit signal; a prose substring does not
get an exact-answer bonus just because an earlier prompt repeated the question.
There is no scope prior or source quota. Confidence and provenance remain visible
but cannot promote an unrelated observed failure over a relevant imported answer.
A query with no sufficient lexical or semantic signal abstains. These relevance
floors are heuristics checked against unrelated-query controls, not probabilities
or a guarantee that every returned claim is true. Supported queries keep weaker
candidates for the active agent's reranking rather than losing multi-answer recall.

Document identity includes scope and namespace. The best chunk per document
brings up to two following chunks (at most 2,400 characters), so a matching heading
can carry its actual decision or procedure. The returned `contextChunkIds` identify
that evidence window. Redundancy filtering, scoped graph expansion, the final
item limit and byte budget are applied once. A shortened excerpt is marked with
`excerptTruncated`, and the result is `partial`; an oversized hit cannot silently
turn useful retrieval into an empty answer. The single-scope `hybridSearch` API
retains its local RRF scoring as a regression reference.

Every scope's engine builds an embedding provider, and one encoder is loaded per
model and shared between them: six scopes would otherwise mean six copies of the
model and six inference sessions. The load is reference counted and released
when the last holder lets go.

Writing is not federated. `memory_record` writes to the project scope; team and
shared content arrives through sync from the systems that own it.

`before_agent_start` runs lexical-only retrieval over the raw prompt and adds at
most four candidates above the automatic-injection threshold to that turn's
system prompt. The threshold defaults to `DEFAULT_RECALL_THRESHOLD` (0.006) and
is overridable per install through `installMemoryHooks({ recallThreshold })`. It does not append a
persistent session message or block startup on a model download. The agent calls
`memory_context` when semantic expansion is warranted.

## Selective capture

The host stages a bounded window of tool results, excluding memory's own tools,
to the newest 64 and appends the resulting evidence id to the tool result seen by
the active agent. Staging is not memory and disappears with the session.
`memory_record` promotes evidence only when the active agent identifies a
reusable decision, correction, constraint, preference, failure, or procedure.
Routine reads and progress are never automatically vectorized.

`SourceAdapter` is the application-neutral ingress boundary, and the built-in
sources are mappings over one generic adapter rather than a class per
publisher. `JsonRecordAdapter` walks a tree of JSON or JSONL records and reads
each through a `RecordMapping`: dot paths with `*` fan-out say where the id,
text, title, timestamp and metadata live, rules derive the kind and trust from
the record's own values, and `keep`/`drop` rules decide what is worth storing.
Undeclared fields fall back to the conventional names, so an ordinary publisher
needs no mapping and an unusual one needs configuration rather than code.

Neither prjct nor pi-team is imported. The shared surface is the directory rule
prjct publishes — `$PRJCT_HOME/teams/<id>/<component>`, which pi-team follows
independently — and the `settings.json` marker each scope carries. Teams are
discovered by reading those markers, which is also what binds a team's id to its
name: the mailbox is keyed by name under the Pi agent directory while the
artifact store is keyed by id under prjct's home, and taking them as separate
arguments let a caller index one team's artifacts into another's scope.

Every adapter declares the scope it belongs to and sync resolves an engine for
that scope, so team knowledge is written to the team's projection. Retrieval
filters on `scopeId`, so an adapter routed at the wrong engine would otherwise
write rows that can never be returned; both the routing and the documents are
checked, and a mismatch fails loudly.

Re-reading a source is driven by work done, not by a clock. A clock re-scans an
idle session for nothing and leaves a busy one stale; the signal that a sibling
may have published something is that this session has been doing things. Two
tables in the project's projection carry it: `sync_activity` counts turns,
context tokens and memories written, monotonically and across restarts, and
`sync_state` records for each adapter when it last ran, what it found, and the
activity watermark at that moment. An adapter is due when any counter has moved
past its threshold since that watermark, subject to a minimum interval that
stops a burst from re-scanning every few seconds.

Both tables live in the projection rather than the journal because they are
operational, not knowledge: a rebuild discards them, and the cost of that is one
extra sync. The host reports total context size rather than growth, so the
per-turn delta is computed by the hook; a context that shrank has been compacted
and its new size is counted as the growth since.

The run is fired without being awaited. A source scan must never sit between the
user's prompt and the agent starting, and a second run cannot begin while one is
in flight.

Source selection distinguishes a request from an answer. prjct's default mapping
keeps failures, verifications and explicitly declared statements, not arbitrary
`user_input` prompts. pi-team's mapping keeps published result bodies, delivered
threads and reported check-in state; empty requests and interrupted placeholders
are excluded. A check-in can contain a substantive final delivery: its title alone
is not a reason to discard it. Ordinary recall also suppresses legacy raw prompts
and unanswered threads already indexed by older presets; an explicit namespace
lookup can still inspect them. Their owner journals are never erased.

Team artifacts retain their full bounded content (up to 512,000 bytes) rather than
an 8,000-character preview that could omit the answer. Source-document journal
events have a 2 MiB serialized bound, consistent with the document contract;
non-document events keep their 64 KiB bound. Record bodies remain bounded too.
After updating a preset, sync re-ingests changed bodies idempotently. Previously
excluded answers become available without changing their imported provenance.

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

The eval also partitions the same corpus deterministically across project, team
and shared scopes. `federatedNoExpansion` must beat the ordinary baseline gate and
must not regress Recall@10, MRR or nDCG@10 against the former per-scope RRF merge
on that partition. This measures the actual public retrieval path, not only the
single-scope reference.

`npm run eval:real -- --cases /private/cases.json` builds a private snapshot of
prjct sources, team mailboxes and the cached local encoder. It never opens original
scope indexes or uses a remote embedding provider. Cases specify project id, query,
expected document ids and optional required excerpt text, or require abstention.
The script checks lexical, hybrid and automatic-injection budgets, full embedding
coverage, and a second idempotent sync. Reports and source data stay outside the
repository. See [real-data evaluation](real-data-evaluation.md) for reuse and cleanup.

The suite is a regression gate, not proof of broad retrieval quality. 42 queries
over 113 documents is small; it must grow with observed production failures.

The benchmark drives the real ingest path (`MemoryEngine.index` and
`indexAll`) over ~1.05 KB documents whose word frequencies follow a Zipf-like
curve over ~5,000 terms, with a deterministic stand-in encoder that gives every
chunk a distinct vector. It reports single-document and batched ingest
separately, KNN latency, whole-query latency, and bytes per chunk. Encoder
inference is deliberately near-free so the throughput figure is the cost of the
storage path; a real local encoder is orders of magnitude slower and would
dominate, so model time is measured separately and never folded in.

Vocabulary shape is part of the measurement, not incidental to it. Lexical
search costs what it costs because a term that appears in most chunks forces
bm25 to score most of the index, so a corpus drawn uniformly from a small
vocabulary reports a worst case that no real corpus produces: the same 100,000
documents built from 60 words put whole-query latency at 568 ms against 103 ms
for the Zipf-like corpus.

Two earlier versions of this benchmark measured something other than the system.
The first bypassed the engine, wrote through projection methods nothing else
used, and stored the identical one-hot vector for all 100,000 chunks against
22-byte documents. The second drove the real path but kept the 60-word
vocabulary described above.

## Boundaries

Local disks on macOS and Linux are supported. Network filesystems, cross-machine
replication, native Windows, unbounded binary ingestion, autonomous community
summarization, and automatic truth decisions are not.
