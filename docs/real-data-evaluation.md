# Real-data retrieval evaluation

Run from a checkout with dependencies installed and the local MiniLM encoder
cached. No push, publication, deployment, or original-scope mutation is involved.

Create a **private** JSON case file outside the repository:

```json
[
  {
    "name": "approved storage decision",
    "projectId": "p_example",
    "query": "What did the team decide about storage?",
    "relevantIds": ["published-answer-id"],
    "contains": "SQLite",
    "maxRank": 3
  },
  {
    "name": "unsupported question",
    "projectId": "p_example",
    "query": "What is the recipe for sourdough bread?",
    "abstain": true
  }
]
```

Select expected ids and excerpt content by reading the original evidence **before**
scoring. A matching title is insufficient: a thread can contain only the question,
while a check-in can contain the final decision. Include unrelated-query controls
and multiple project contexts. Historical design evidence is not proof that the
current implementation follows that design.

```sh
npm run eval:real -- --cases /private/cases.json
```

The command snapshots `PRJCT_HOME` (default `~/.prjct`), the Pi team mailbox,
and the cached local encoder into a new private temporary workspace. It excludes
old memory/vector indexes, backups and symlinks. It then ingests through the real
source registry into new workspace indexes. Original configuration cannot select
a remote encoder: every engine receives an explicit local provider with a copied
model cache. Optional overrides are `--home`, `--mailbox`, and `--model-cache`.
An explicitly supplied `--workspace` must not exist on the first run.

Each case runs in three modes:

- lexical lookup: six results, 12,000-byte item budget;
- hybrid lookup: the same budget, real embeddings;
- automatic recall: lexical only, four results, 2,200 bytes, using the installed
  default score threshold.

Positive cases require a known id **and** the optional `contains` text inside the
returned excerpt, within `maxRank` (default three). Negative cases require
abstention. Every changed source document must have been embedded, and a second
sync must index zero documents. Any failed check exits nonzero.

The command prints the workspace and report path. Reuse the exact snapshot to
compare ranking changes without copying changing live inputs or embedding again:

```sh
npm run eval:real -- --cases /private/cases.json \
  --workspace /private/pi-memory-real-EXAMPLE --reuse
```

`report.json` includes ids, titles, scopes, reasons, scores, budgets' outcomes,
ingestion counts and idempotency evidence. It deliberately excludes source bodies.
The workspace still contains private source data and embeddings: do not commit,
upload or attach it to a PR. After keeping the redacted report you need, remove
only the workspace path printed by the command.

## Limits

Passing cases proves those retrieval behaviors, not perfect factual answers.
The active agent still verifies dates, provenance, supersession and applicability.
Candidate retrieval is bounded and reports exhaustion as a gap. Different
embedding spaces degrade to lexical service. Very small byte budgets can shorten
an evidence window (`excerptTruncated: true`, `status: partial`). The relevance
floors are heuristics; keep expanding both positive and negative cases as real
failures appear.


## Real-content lifecycle fault injection

Use a snapshot produced above as read-only input. Create a separate private case:

```json
{
  "scopeId": "t_example",
  "documentId": "actual-stored-artifact-id",
  "query": "actual-artifact-name.md"
}
```

```sh
npm run eval:freshness -- --workspace /private/pi-memory-real-EXAMPLE \
  --case /private/freshness-case.json
```

The command copies one real artifact and the real local encoder into a **new**
sandbox. It never opens the input snapshot's indexes. An identity-anchored query
isolates temporal admission from ranking; this is not a substitute for the
natural-language/full-corpus relevance suite above. Optional `contains` also
checks excerpt text, but must be chosen from independently inspected evidence.

It checks 12 lifecycle states in lexical, hybrid and automatic configurations
(36 checks): original visibility; an unchanged-body validity amendment at the
exact cutoff and one millisecond earlier; rebuild; a changed-body/newly published
revision; exclusion of that revision from an earlier query; malformed/unavailable
sources and missing blobs; latest raw revision selection; source removal; and
retirement after rebuild. Failed checks exit nonzero. Dates, removal and the
revision footer are **simulated faults**, not claims that the real publisher
expired or changed that PRD. The real source text remains untouched.

A small-corpus probe also exposed a retrieval limitation: a broad integration
question against the isolated PRD can abstain in automatic mode, while hybrid
retrieval can choose an excerpt without the expected integration marker. The
identity-anchored lifecycle case passes; the original natural-language cases
still pass against the full copied corpus. Do not present the 36 lifecycle checks
as evidence that this small-corpus relevance problem has been solved.

Source validity is not semantic currency. Neither a filename version nor a recent
observation certifies a historical proposal as today's implementation. Also,
external source `asOf` is a validity filter on the latest indexed revision, not
full historical reconstruction. Keep the sandbox/report private and remove only
the generated sandbox when finished.
