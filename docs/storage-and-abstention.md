# Storage maintenance and retrieval abstention

## WAL policy

SQLite remains the only project authority, in WAL mode with `synchronous=FULL`.
New bounded projects use the compact single-snapshot layout; existing and large
projects use the indexed layout. Current-schema opening performs no schema or
persistent PRAGMA write. Ordinary extension turns do not checkpoint.

Compact publication checkpoints any prior generation before taking its writer
lock, rechecks WAL/mode/owner/revision under that lock, admits the compressed
snapshot before `UPDATE`, and writes at most one bounded generation. A pinned
reader causes explicit busy backpressure instead of WAL accumulation. History
and its domain reduction are one SQLite commit, so compact mode has no JSONL
append/apply gap. Indexed mode retains the maintenance policy below.

The explicitly invoked daemon's `processAvailable` checks maintenance before
materializing work and between completed jobs, outside publication transactions
and their error handlers. `Projection.checkpointWal()` uses
`wal_checkpoint(TRUNCATE)` with a zero busy timeout, restoring the original
connection timeout in `finally`. An active reader or competing writer wins
immediately; no snapshot is killed and no committed job is relabeled. The next
safe boundary retries. `/memory checkpoint-wal` is the explicit manual boundary.
It is distinct from the operational `/memory checkpoint {json}` command.

PASSIVE alone would copy frames but retain the WAL high-water allocation.
TRUNCATE releases that allocation only when SQLite permits it. If a pinned reader
prevents truncation and the WAL reaches 8 MiB, the daemon pauses further job claims
and retries on a later cycle. This is a soft boundary: one in-flight bounded job
may exceed it, and unrelated processes writing directly to SQLite can still grow
the file. A strict file-size cap while arbitrary readers remain pinned would
require rejecting writes; silently deleting WAL is never safe. Maintenance does
not VACUUM the authority or change the crash/rebuild contract.

Tests cover independent processes holding readers/writers, timeout restoration,
FULL durability, transaction rejection, pressure backoff, 30 repeated batches,
and SIGKILL before commit, after commit, and after checkpoint, followed by reopen
and rebuild. Existing ownership/isolation/hot-open suites remain applicable.

## Default relevance gate

`memory_context lookup`, direct engine search, and automatic recall apply the
same deterministic evidence-coverage policy before rank fusion. A project name
shared across much of the corpus is context, not evidence for an unknown
attribute. Focus terms omit corpus-ubiquitous terms except explicit subsystem
predicates. A small documented-in-code EN/ES vocabulary normalizes retrieval
terms; it neither generates answers nor calls a model.

Ordinary questions need at least half their focus terms in the candidate. In
corpora of at least 100 chunks, two matching terms each occurring in at most 1%
of the corpus also establish lexical corroboration; this preserves long
investigative prompts whose answer omits the surrounding prose.
Verification questions can retain qualified contrary evidence at 30% coverage
when the candidate contains an explicit contrast and the requested subsystem
predicate. Thus authoritative SQLite evidence can answer the MongoDB-primary
question. This is not blanket suppression of negative questions. Short
conceptual searches (at most two normalized terms) can additionally use a
cosine floor of 0.6; longer attribute questions cannot be rescued by shared-topic
embedding similarity alone. Exact document identifiers remain retrievable.

No caller score threshold is required. Optional thresholds can narrow accepted
results but do not disable this gate. Automatic recall no longer adds a positive
rank-score floor that excluded supported Spanish/qualified matches. Insufficient
evidence returns `status=abstained`, `items=[]`, and an explicit gap. Automatic
recall injects no candidates and states the abstention, without claiming the
requested fact does not exist.

These are calibrated retrieval heuristics, not answer verification. Long
cross-vocabulary paraphrases may be rejected; arbitrary adversarial queries can
still yield false positives, especially short dense-only queries. The active
agent must inspect qualifications/citations and verify relevance. No universal
precision or real-model semantic acceptance is claimed.

## Corrected offline real-project diagnostic

Run explicitly against an isolated caller-selected checkout and new workspace:

```sh
node --import tsx scripts/bench-project-offline.ts \
  --implementation /path/to/pi-memory \
  --corpus /path/to/isolated/prjct-cli \
  --workspace /path/to/new-workspace
```

The runner refuses an existing workspace, uses an injected offline test encoder
and seven deterministic evidence rules, and forbids `fetch`. It does not run an
analysis/answer provider, download a model, or alter publisher files. It runs the
same workload against a supplied baseline implementation. Raw files are read
transiently; reports include selected statements, hashes and measurements, not
publisher bodies. A larger corpus is tracked documentation plus substantive
`core/**/*.ts`, not repeated padding. Seven facts are ingested; oracles query six
of them plus explicit unanswerables. Capture-gate is ingested but unqueried.
This is **not proof that all knowledge in the larger corpus is preserved**.

The oracle fixture distinguishes unanswerable O8 from answerable contrary O7.
`scoreOracle` accepts an unanswerable case only with no items, explicit abstention,
and an insufficient-evidence reason. Returning unrelated text that lacks a
forbidden answer is a failure. Storage errors or empty hit arrays alone do not
pass. Positive recall, candidate precision and reciprocal rank remain substring
**diagnostics**, never a synthesis PASS. Generated-answer, real-embedding, and
real-analyzer quality remain unreviewed without authorized providers, models,
credentials, private-data permission and budget.

### Measured comparison (development evidence, not independent acceptance)

Pinned project: `4a0db36713d7af7ae78d123df5a303f1d3d954cd`.
Tiny: 5 files, **68,857 B**. Larger:
1,031 tracked code/documentation files, **7,381,450 B**. Both implementations
receive identical source digests and the same seven-ingested-rule workload.

| Total bytes, including journal | r16 tiny | r17 tiny | r16 larger | r17 larger |
| --- | ---: | ---: | ---: | ---: |
| Peak live, sampled at transaction boundaries | 4,788,004 | 1,151,527 | 7,351,104 | 3,507,192 |
| Live after daemon drain | 4,788,004 | 606,076 | 7,351,104 | 3,165,056 |
| Explicit clean quiescent | 606,076 | 606,076 | 3,165,056 | 3,165,056 |
| Closed | 573,308 | 573,308 | 3,132,288 | 3,132,288 |
| Reopened | 606,076 | 606,076 | 3,165,056 | 3,165,056 |
| Maximum sampled WAL | 4,198,312 | 737,512 | 4,202,432 | 1,891,112 |

The larger selected store is genuinely smaller than the raw-source baseline at
both observed peak and quiescence. The tiny corpus is **NOT A WIN**, even clean:
606,076 B is about 8.8 times its source size. Its measured break-even source size
for this exact selection is 606,076 B; the larger workload's is 3,165,056 B. These
are workload-specific comparisons, not a universal compression threshold. An
empty current authority alone measured 344,064 B plus 32,768 B SHM after checkpoint;
initial schema setup transiently allocated 708,672 B WAL. Vector tables and
per-source coverage/lineage add further fixed and variable overhead.

At clean quiescence/reopen the tiny store is SQLite 536,576 B + SHM 32,768 B +
journal 36,732 B; the larger is SQLite 2,940,928 B + SHM 32,768 B + journal
191,360 B. Both have zero WAL and zero checkpoint sidecar/other bytes. Operational
checkpoints live inside SQLite and must not be counted twice. The report separates
SQLite/WAL/SHM/journal/checkpoint/other for every phase. Baseline clean measurement
uses an explicit benchmark checkpoint; r16 did not do that automatically. The
original external 4,747,152-B figure is preserved as a non-win, not overwritten by
this slightly different, journal-inclusive seven-rule rerun.

| Diagnostic (lookup/automatic, lexical/default dense) | r16 tiny | r17 tiny | r16 larger | r17 larger |
| --- | ---: | ---: | ---: | ---: |
| Unanswerable requests returning items / 20 | 14 | 0 | 11 | 0 |
| Explicit negative abstention rate | 0% | 100% | 0% | 100% |
| Positive/qualified/temporal recall | 92.9% | 100% | 89.3% | 100% |
| Candidate substring precision | 32.9% | 80.0% | 33.1% | 79.0% |
| Reciprocal-rank diagnostic | 0.768 | 0.911 | 0.804 | 0.982 |
| First-query latency, ms | 5.92 | 8.77 | 4.14 | 5.41 |
| Warm p50 / p95, ms | 1.98 / 3.07 | 1.98 / 2.98 | 3.71 / 6.97 | 3.83 / 6.52 |

Latency is a small offline sample (five warmed repetitions per case/route), not a
production SLO or truly cold OS-cache claim. MRR is computed from the actual first
matching item, not assigned 1 whenever any result exists. Historical retrieval
unit/scale gates remain unchanged. The real-encoder `npm run eval` gold
recall/MRR/nDCG gate remains BLOCKED pending explicit model authorization.

Evidence: `/Users/jj/.pi/agent/teams/pime/r17-dev-validation-20260915/{baseline-r16,candidate-r17-final}/report.json`.

### r18 compact result

An isolated offline run of the same pinned `prjct-cli` workload measured all
persistent bytes (SQLite, WAL, SHM, JSONL, checkpoints and other files):

| Total bytes | 68,857-B tiny | 7,381,450-B larger |
| --- | ---: | ---: |
| Peak live | **59,000** | **3,328,910** |
| Clean quiescent | **45,568** | **3,177,711** |
| Closed | **12,800** | **3,144,943** |
| Reopened | **45,568** | **3,177,711** |
| Maximum sampled WAL | **13,432** | **1,886,992** |

The tiny workload remains compact and is below its 68,857-B source size in all
four required phases. The larger source is admitted to indexed mode before its
first durable mutation and remains a storage win. The same run passed 25/25
mechanical rows, used zero network/model downloads, returned zero false positives
for 20 unanswerable routes, and explicitly abstained on O8 in 4/4 routes. Those
scripted lexical/dense checks are diagnostic only. Generated-answer and synthesis
quality remain unreviewed until a provider, model, private-data permission and
budget are explicitly authorized. Independent item-level retrieval review of the
frozen R19 fixture is recorded in the R19 corrected evaluation artifacts, not in
these historical r16–r18 tables.
