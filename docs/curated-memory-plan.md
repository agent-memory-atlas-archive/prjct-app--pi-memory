# Curated memory and refresh jobs

Status: **implemented** (standalone daemon + curated ingest; see remaining limitations below).
The memory analysis/refresh worker must continue when Pi is closed. It is not
conditional on another interactive turn or task-close hook. pi-memory should
retrieve important, evidence-backed knowledge, not become a second copy of its
publishers' documents and journals.

## Evidence from the current implementation

- `src/index.ts` schedules source synchronization based on activity. That work
  scans and indexes; it does not synthesize knowledge.
- `src/sources/registry.ts` sends selected source documents directly to
  `MemoryEngine.indexAll`. Artifacts can retain up to 512,000 characters through
  `src/sources/presets.ts`.
- `src/engine.ts` journals the source document before creating its lexical/vector
  projection. Removing chunks alone would leave original bodies in the journal.
- `src/retention/consolidation.ts` proposes similar fact pairs mechanically. It
  does not analyze source documents, publish summaries or refresh a topic.
- The retained real-data evaluation snapshot contains **507 source documents,
  2,908 embedded chunks and zero temporal facts**. Its successful retrieval tests
  establish document retrieval, not successful knowledge distillation. This is a
  measurement of that evaluation snapshot, not of every installed scope.

The preceding ranking and validity fixes remain useful, but are infrastructure
under the desired memory layer, not proof that the desired layer already exists.

## Reference implementations reviewed

### prjct-cli

Repository: `/Users/jj/Apps/prjct/prjct-cli`.

- `core/services/living-context-contract.ts`: the agent that executed the task
  synthesizes its durable meaning; detector output is input, not final context.
- `core/services/retention/capture-gate.ts`: admission before storage, exact and
  semantic redundancy handling, and stricter treatment of automatic captures.
- `core/services/memory-dream.ts`: a gated orient/gather/consolidate/prune cycle,
  invoked manually or on task/session closure. Its defaults are 24 hours and
  five session closures; it is deterministic, not an independent semantic analyst.
- `core/services/memory-index.ts`: a bounded discovery index (currently 1,500
  characters), followed by selective retrieval rather than a full prompt dump.
- `core/services/retention/distill.ts`: bounded residue rather than indefinite
  retention of low-value automatic history.

Do not copy these mechanisms uncritically. The deterministic distill builds
counts and title cues, not an explanation of the underlying decisions. It also
attempts deletion even when writing the digest reports failure. Its dream lock
is a read-then-write, fail-open guard, not a suitable multi-session lease for
pi-memory. Novelty or similarity alone must not reject an important correction.

### Jarvis API

Repository: `/Users/jj/Apps/amtelser/jarvis-agent/api`.

- `app/intelligence/business_memory.py`: the active model selects a concise
  concept, uses a stable `semantic_key`, updates its revision and keeps bounded
  history. The harness validates, persists and retrieves; revised text never
  retains an old vector. Semantic retrieval is bounded and does not pad an
  available embedding search with unrelated recent notes.
- `app/intelligence/findings.py`: compact findings carry their query scope and
  `corpus_version`. Changed evidence invalidates reusable figures. Per-thread
  retention and rendered context both have explicit limits.
- `app/external_signals/batch/resummarize.py` and
  `app/external_signals/worker/__init__.py`: scheduled, bounded reprocessing
  reuses the normal classification pipeline and stops matching once upgraded.

These are separate mechanisms, not one universal consolidation worker. Jarvis
still owns raw source/conversation stores; its compact memory layer is the useful
analogy. A periodic embedding backfill is not semantic analysis.

## Target architecture

```text
Publisher-owned sources (not copied into the memory journal)
    -> source identity/revision manifest
    -> bounded, persistent analysis queue
    -> semantic selection + synthesis + validity review
    -> validated knowledge revisions + compact topic summaries
    -> embeddings / FTS of curated text only
    -> relevant, bounded context with source references
```

### Persist

1. Atomic, self-contained decisions, constraints, verified lessons, corrections
   and reusable procedures. Record applicability, not only a sentence fragment.
2. A compact current summary per topic, linked to its supporting fact revisions.
   A summary complements atomic facts; it must not collapse qualifications or
   conflicting viewpoints into one apparently certain narrative.
3. Source references: owner scope, source id, URI/locator, revision/hash and
   observation time. Retain validity and provenance separately from relevance.
4. Operational state: source fingerprints, job cursor, lease, attempts, budget,
   input/output revisions and outcome counts.

### Do not persist as memory

Whole artifacts, tool outputs, request echoes, transcripts, routine progress,
detector dumps, or repeated generic statements about memory maintenance itself.
A source reference is not a copy of the source. Read raw evidence transiently from
its owner when analysis or verification actually needs it. If that evidence is
unavailable, expose the gap; do not manufacture or silently refresh knowledge.

## Refresh job contract

- **Triggers:** substantive work completion, changed source fingerprints,
  corrections/stale feedback, and due validity reviews. Coalesce triggers; avoid
  scanning or analyzing the entire corpus on every turn. A time trigger alone
  does not justify repeating model work against unchanged inputs.
- **Incremental selection:** a persistent watermark and source-to-knowledge
  dependency links identify affected topics. Do not embed raw inputs just to
  decide whether they deserve memory.
- **Claim:** a transactional, scope-qualified lease prevents two sessions from
  processing the same revision concurrently. Interrupted jobs remain recoverable.
- **Analyze:** read a bounded evidence bundle; select what changes future action;
  compare it with the current topic and emit keep/create/revise/supersede/discard
  proposals. Statements in sources remain untrusted data, never instructions.
- **Validate:** enforce source references, scope, output size, permitted kinds,
  temporal bounds and nonempty substance. Distinguish decisions from proposals,
  hypotheses and one-off failures. Preserve unresolved contradictions explicitly.
- **Publish:** compare source and topic revisions before committing. Reject an
  obsolete job result instead of overwriting newer knowledge. Commit facts,
  topic summary and lineage together; only embed changed curated text. A failed
  embedding may defer the dense leg, never attach an old vector to new meaning.
- **Finish:** advance the successful watermark only after publication, or record
  a substantiated no-change/discard outcome. Failed jobs retry with backoff and a
  budget; failure is not a successful refresh.
- **Report:** analyzed sources, accepted/revised/superseded/discarded facts,
  pending work, source gaps, token cost and elapsed time. "Job ran" is not proof
  that the memory is useful or current.

## Confirmed execution model: autonomous daemon

The former active-agent-only restriction is superseded for background memory
maintenance. An explicitly configured standalone daemon owns semantic analysis,
consolidation and refresh, including while Pi is closed. The Pi extension owns
interactive retrieval, source/correction signals and status; it must not launch
hidden model calls or rely on a session hook to keep the worker alive.

The daemon needs:

- A process lifetime independent of Pi, with explicit start/stop/status and a
  one-shot mode for testing. Service installation and persistent activation are
  separate, explicitly authorized operations.
- Scheduled change detection as well as queued activity signals. With Pi closed,
  changed publisher inputs must still become due; unchanged inputs must not cause
  repeated model calls. A maximum review age covers validity dependencies that
  cannot be expressed as local file changes.
- Durable queue/cursors, transactional claims, bounded retries, graceful shutdown
  and recoverable interrupted jobs. Never advance success after failed analysis.
- An explicit analysis provider/model, deadlines, per-job input/output limits and
  a persistent spending/call budget. Missing authentication or exhausted budget
  leaves visible pending work rather than selecting another model silently.
- Read-only access to publisher evidence, transient analysis input and curated
  output only. No filesystem/shell tools are required by the synthesis model;
  source payloads, prompts, chain-of-thought and full responses must not be logged.
- Validated, revision-checked publication and embedding of changed knowledge only;
  interactive queries never wait for the analysis job.

`prjct-cli/core/daemon/daemon.ts` provides a useful process-lifecycle reference,
but its daemon primarily keeps CLI modules warm and serves IPC requests. That is
not itself a scheduled memory analyst. Jarvis's `app/worker.py` and per-module job
registration are the closer reference for autonomous scheduled work. Reuse public
interfaces where available, not imports into either application's internals, and
do not inherit the CLI daemon's interactive-idleness policy for a worker that must
maintain memory without interactive sessions.

The daemon may use documented Pi SDK/model APIs independently of an interactive
session. This does not require an MCP server, a cloned coding-agent toolset, or
multiple competing reasoning loops. The configured background analyzer is an
explicit component with observable work and cost—not an invisible side effect of
retrieval.

## Migration and acceptance

Migrate on copies first. Produce curated knowledge from a bounded source set,
verify its meaning, and build a new curated-only projection. Do not merely hide
raw namespaces from retrieval: the old document events, checkpoints and backups
would still retain raw bodies. Purging pi-memory-owned historical copies requires
an explicit migration/checkpoint strategy; never delete publisher-owned sources.
Do not discard the only recoverable input after a failed synthesis.

Reuse the real-data cases, but change the positive oracle from document ids to
supported conclusions and their evidence references. Keep unrelated-query and
temporal controls. Required gates include:

- No raw source body reaches the new memory journal, FTS or vectors.
- Known important decisions and qualifications survive synthesis and retrieval.
- Changed/withdrawn evidence invalidates dependent knowledge; a draft cannot
  silently become an approved decision.
- Same input/policy revision produces no duplicate facts or embeddings.
- With no Pi process running, a changed source is analyzed and the next Pi
  session retrieves the updated curated knowledge without running ingestion.
- Restart, retries and competing workers do not skip inputs or publish stale work.
- Idle daemon cycles make no model/embedding calls; deadlines, missing credentials
  and exhausted budgets leave accurate, inspectable job state.
- Unavailable sources, invalid model output and embedding failure fail honestly.
- Measure retained bytes, vector count, prompt tokens, answer correctness,
  unsupported-claim rate, freshness lag and p95 latency against the same corpus.

Do not claim "most efficient" from compression alone. Less stored text is useful
only if important knowledge, provenance and answer quality survive.

## Implemented behavior

- Default `SourceRegistry.sync` records fingerprints and enqueues jobs. It does
  not append `document.upserted` events for publisher bodies. `MemoryEngine.index`
  / `indexAll` remain the explicit low-level vector API (used by gold/real document
  retrieval evals).
- Operational state lives in `curation.sqlite` beside `index.sqlite`: fingerprints,
  jobs, scoped leases, spend, topic revisions, source-to-fact lineage. Knowledge
  rebuilds do not drop that file.
- `scripts/memory-daemon.ts once|start|stop|status|run` is the standalone worker.
  The Pi extension never starts it. Service installation is not implemented.
- Analysis uses `ModelRuntime.create` + `completeSimple` for an explicitly
  configured provider/model. Missing auth/model or exhausted budget blocks jobs.
  There is no silent model fallback and no tools/MCP.
- Publication writes temporal facts plus `memory.topic` summaries, embeds curated
  text only, and rejects stale source/topic revisions. Proposals cannot become
  `supported` from imported evidence. Withdrawals mark dependents contradicted;
  changes mark them `needs_review`.
- `/memory migrate-curated` checkpoints the journal/projection and enqueues legacy
  raw documents. It does not rewrite or delete historical events.

## Remaining limitations

- Historical `document.upserted` events still contain raw bodies until an explicit
  future journal compact (not implemented). `VACUUM INTO` plus a journal copy is
  not a purge. Publisher sources are never deleted.
- Interactive recall defaults to `memory` and `memory.topic`. Explicit `namespaces`
  can still inspect legacy raw copies already in a projection. New sync does not
  add more of them.
- Per-source topic documents (hash of the source key) are not a merged concept
  graph. Fact `semanticKey` values are preserved for later consolidation.
- Unit tests inject a scripted analyzer. `eval:curated` uses ModelRuntime only when
  provider and model resolve; otherwise it reports `semantic: mock`.
- Real-corpus document-id and lifecycle evals remain explicit low-level index tests,
  not curated-freshness proofs.
