# pi-memory

Pi-native temporal memory and hybrid retrieval for agents. The active Pi agent is
the only reasoning engine; this extension supplies durable evidence, indexing,
retrieval, and bounded garbage collection.

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
  useful/wrong/stale feedback.
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
/memory replay
/memory rebuild
/memory gc
```

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
npm run bench -- --documents 100000 --queries 1000
npm pack --dry-run --ignore-scripts

# Real Pi load smoke test, without calling an LLM provider.
PRJCT_HOME=$(mktemp -d) pi --mode rpc --no-session --no-extensions -e ./index.ts <<'EOF'
{"type":"prompt","message":"/memory status"}
EOF
```

The evaluation gate requires at least 20% relative nDCG@10 improvement over the
best BM25, feature-hash, or old-style RRF baseline without Recall@10 or MRR
regression.
