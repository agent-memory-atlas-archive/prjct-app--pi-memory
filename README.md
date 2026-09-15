# pi-memory

Pi-native temporal memory and hybrid retrieval for agents. The extension supplies
durable evidence, indexing, retrieval, and bounded garbage collection.

**Architecture:** the Pi extension retrieves and records; a standalone daemon
(`npm run daemon -- once|start|stop|status`) analyzes changed sources while Pi is
closed. Default `/memory sync` fingerprints publishers and enqueues work — it does
not copy raw source bodies. Configure `PI_MEMORY_ANALYSIS_PROVIDER` and
`PI_MEMORY_ANALYSIS_MODEL`. Do not install a persistent service unless explicitly
authorized. See [the design](docs/curated-memory-plan.md).

## Install

Requires Pi, Node.js 22.19 or later, macOS or Linux.

```sh
pi install npm:@prjct.app/pi-memory
```

The first dense operation downloads the default local multilingual encoder into
`~/.prjct/shared/memory/models`. Until it is available, writes and lexical search
continue to work and report that dense indexing is pending.

## Agent tools

- `memory_context` searches with up to four agent-authored query expansions,
  inspects ids, proposes consolidation candidates, and records
  useful/wrong/stale feedback. Lookup covers **every scope the session can
  read** — this project, each team on the machine, and the shared scope —
  because a decision a teammate recorded answers the question as well as one
  recorded here. Pass `scopes: ['project']` to narrow it.
- `memory_record` stores a selective temporal fact, appends a resolution instead
  of rewriting history, or indexes a generic source document.

The extension keeps a bounded, session-local staging window for host tool
results and exposes each staged `ev_` id in the corresponding tool result;
nothing is persisted unless the active agent selectively promotes an observation
with `memory_record`. Memory's own tools are excluded to prevent self-citation. The agent cannot mint native provenance. An explicit user
statement is accepted only when `userQuote` occurs verbatim in the current
prompt.

The agent should remember decisions, corrections, stable constraints,
preferences, verified failures, and reusable procedures—not routine reads,
progress narration, secrets, or generic summaries.

## Commands

```text
/memory status
/memory sources          # counters, last run per adapter, queued jobs, and what is due
/memory sync [adapter]   # scan and enqueue now; does not copy raw source bodies
/memory replay
/memory rebuild
/memory gc
/memory migrate-curated  # checkpoint raw journal/projection and enqueue legacy documents
```

Daemon (separate process, never started by the extension):

```sh
npm run daemon -- status
npm run daemon -- once --home "$PRJCT_HOME" --provider anthropic --model claude-sonnet-4-5
npm run daemon -- start --home "$PRJCT_HOME" --provider anthropic --model claude-sonnet-4-5
npm run daemon -- stop
```

## Sources

`/memory sync` scans the siblings that publish into this machine's prjct home
and enqueues changed identities for the daemon. It does not copy their bodies
into the memory journal. Nothing is imported from those apps: the shared surface
is the directory rule prjct publishes and the `settings.json` marker each scope
carries.

- **prjct observations** — the project's own observation stream.
- **pi-team** — for every team discovered under `$PRJCT_HOME/teams/*/settings.json`,
  the settled journal (from the mailbox under `$PI_CODING_AGENT_DIR/teams`) and
  the content-addressed artifact store.

Each adapter declares the scope it belongs to, and sync indexes it into that
scope's own projection — team knowledge into the team, project observations into
the project. Routing an adapter at the wrong scope is refused rather than
silently writing rows retrieval can never return. Retrieval then reads across
all of them, so indexing into a team scope is not the same as hiding it.

Scopes contribute candidates concurrently; one global ranking uses shared
lexical statistics and measured cosine similarity. Unrelated source winners do
not get a scope bonus or a reserved slot. When no sufficient signal exists,
retrieval abstains. Evidence windows preserve the continuation of matching
headings, and byte-limited excerpts are explicitly marked as shortened.
`memory_record` still writes to the project — reading is federated, writing is not.
See [real-data evaluation](docs/real-data-evaluation.md) for reproducible,
private-snapshot checks with the real encoder.

### When sources are re-read

Sync is not on a schedule and does not run at start-up. Each turn adds to a
watermark table in the project's projection — turns taken, context tokens
consumed, memories written — and a source is re-read only once the work done
since its last run crosses a threshold:

| | default |
|---|---|
| turns since last run | 20 |
| context tokens since last run | 40,000 |
| memories written since last run | 10 |
| minimum time between runs | 5 minutes |

Any one threshold is enough; the minimum interval overrides all of them, so a
burst of activity cannot re-scan the sibling stores every few seconds. The run
happens in the background, so a turn never waits on it, and never twice at once.

`/memory sources` shows the counters, each adapter's last run, and why it is or
is not due. `/memory sync` ignores all of it and runs anyway. Adjust or disable
with `installMemory(pi, { sync: { everyTurns: 50, enabled: false } })`.

A failed run is recorded like a successful one, so a source that throws every
time is visible as failing rather than looking like one that has never run.

Source selection distinguishes questions from answers. prjct keeps failures,
verifications and explicitly declared statements, not raw user prompts. pi-team
keeps published result bodies, delivered threads and check-in replies, not empty
requests or interrupted-turn placeholders. Artifacts retain their full bounded
content instead of an 8,000-character preview that might omit the answer.

### Connecting anything else

Sources are described, not coded. `JsonRecordAdapter` walks a tree of `.json`
and `.jsonl` files and maps records with a `RecordMapping`; when a field is not
declared it is found under the conventional names, so an ordinary publisher
needs no mapping at all:

```ts
import { JsonRecordAdapter, SourceRegistry } from '@prjct.app/pi-memory/sources';

const adapter = new JsonRecordAdapter({
  id: 'my-source',
  scope: { kind: 'project', id: projectId },
  root: '/path/to/records',
  mapping: {
    namespace: 'my.source',
    container: 'envelope.items',          // where records live inside a .json
    id: ['ref'], text: ['blurb'], observedAt: ['when'],
    kind: { rules: [{ when: [{ field: 'level', equals: 'high' }], kind: 'decision' }], fallback: 'note' },
    trust: { from: 'level', when: { high: 'host' }, fallback: 'agent' },
    metadata: { level: 'level' },
    select: { keep: [{ field: 'level', oneOf: ['high', 'medium'] }] },
  },
});
```

Paths support nesting and `*` fan-out (`replies.*.state`). Timestamps are
accepted as ISO strings, epoch seconds or epoch milliseconds. Selection is a
rule set — `keep` is a disjunction, `drop` vetoes — so what a source contributes
is configuration, not a code change. Pass extra adapters through
`installMemory(pi, { extra: [...] })`, and override any built-in selection with
`{ observations, teamJournal, mappings }`.

## One product, reusable vector layer

Vector retrieval is part of this package, not a separate service or extension.
Other applications can index arbitrary `SourceDocument` records through the
agent tool or import the same implementation:

```ts
import { openVectorIndex, TransformerEmbeddingProvider } from '@prjct.app/pi-memory/vector';

const vectors = openVectorIndex({
  path: '/absolute/path/to/rebuildable-index.sqlite',
  provider: new TransformerEmbeddingProvider(),
});
```

The default provider is a quantized local multilingual sentence encoder. An
OpenAI-compatible embedding endpoint can be selected in the scope's
`memory/config.json`; credentials are read from the host environment and are
never persisted by pi-memory.

Known supply-chain caveat: `@huggingface/transformers` currently brings
`onnxruntime-node` and image-processing dependencies whose audit advisories may
report no fixed release. pi-memory uses the text feature-extraction path only;
review `npm audit --omit=dev` before publishing or deploying.

## Storage

Project data lives at `~/.prjct/<projectId>/memory` (or `$PRJCT_HOME`). Team and
shared scopes use `~/.prjct/teams/<teamId>/memory` and
`~/.prjct/shared/memory`. Immutable, hash-chained events are appended under
`events/<YYYYMMDD>/<writer>.jsonl`; `index.sqlite` is a disposable FTS5,
temporal-graph, and sqlite-vec projection rebuilt from those events.

See [Architecture](docs/architecture.md) for retrieval, concurrency, retention,
and provenance details.

## Development

```sh
npm run check
npm test
npm run test:integration
npm run eval -- --suite tests/fixtures/retrieval-gold.jsonl
npm run bench -- --documents 5000 --queries 1000
npm pack --dry-run --ignore-scripts

# Real Pi load smoke test. /memory status is a slash command, so no provider is
# called; note the "id" field, which the RPC response is matched on.
PRJCT_HOME=$(mktemp -d) pi --mode rpc --no-session --no-extensions -e ./index.ts <<'EOF'
{"id":"memory","type":"prompt","message":"/memory status"}
EOF
```

The evaluation gate requires at least 20% relative nDCG@10 improvement over the
best BM25, feature-hash, or old-style RRF baseline, with no Recall@10 or MRR
regression. It scores the system **without** the fixture's hand-written query
expansions; see [Architecture](docs/architecture.md) for why.

### Measured on an M-series laptop

Documents of ~1.05 KB drawn from a Zipf-like vocabulary of ~5,000 terms, one
chunk each, with a deterministic stand-in encoder:

| | 5,000 docs | 100,000 docs |
|---|---|---|
| ingest, `index()` one at a time | 187 docs/s | 199 docs/s |
| ingest, `indexAll()` in batches | 4,244 docs/s | 2,847 docs/s |
| KNN p95 | 0.64 ms | 12.6 ms |
| whole hybrid query p50 | 13.6 ms | 74.4 ms |
| whole hybrid query p95 | 15.2 ms | 105.7 ms |
| resting size | 7.19 KB/chunk | 6.82 KB/chunk |

Single-document ingest is bounded by one `fsync` per journal entry (~3.8 ms),
which is the durability guarantee, not overhead to be optimized away.
`indexAll()` trades it for one `fsync` per batch: a crash can lose the tail of a
run, which is then re-ingested. Use `index()` when a single write has to survive
on its own. Real encoder inference is not included in these figures and will
dominate them.

Whole-query latency is dominated by FTS5 bm25 scoring and grows with corpus
size. Three things keep that in hand: no search leg joins `documents`;
`lexicalSearch` keeps at most the twelve most selective terms of a query; and
above 5,000 chunks it drops terms appearing in more than 5% of the corpus
outright, because their bm25 contribution is near zero while the cost of
scoring every chunk they appear in is not.

That last one matters most for the queries the automatic hook actually sends —
a whole user prompt, mostly ordinary words around a few real ones. Measured with
eight known documents buried in 100,000 of filler and queried in prompt form,
recall@10, MRR and nDCG@10 are identical with the ceiling and without it, while
p50 goes from 88.6 ms to 2.9 ms. The benchmark's own queries are slices of
corpus text and so carry far more mid-frequency terms than a real prompt, which
is why its end-to-end figure improves by less.

Corpus vocabulary matters as much as corpus size: the same 100,000 documents
drawn from a 60-word vocabulary put the query at 568 ms, because every term then
matches nearly every chunk and there is nothing selective to choose.


### Freshness validation

Source sync detects validity/metadata-only changes and retires missing documents
only after a complete, ownership-scoped scan. Failed source checks preserve the
index with a freshness warning. Recall exposes dates; historical proposals are
not automatically certified as current. See [temporal semantics](docs/architecture.md#source-freshness-and-retirement)
and [real-content lifecycle validation](docs/real-data-evaluation.md#real-content-lifecycle-fault-injection).

### Storage and abstention boundaries

See [WAL maintenance, default abstention, and the corrected offline benchmark](docs/storage-and-abstention.md).
The 68,857-byte tiny source corpus is **not a storage win**, even after checkpointing.
Larger-corpus savings apply only to the measured selected-memory workload; semantic
answer quality remains blocked pending authorized model evaluation.
