# Model-switch context handoff

Pi 0.85.1 `context` can replace `AgentMessage[]` before each LLM call. `model_select` fires on set/cycle/restore. This module does **not** start the memory daemon, invoke compaction, or run hidden analysis.

Provider prompt cache (Anthropic/OpenAI cache keys) is **not** pi-memory. Handoff only rewrites the messages Pi sends; it does not claim to flush provider caches. Cache notices remain ordinary retained messages when their complete turn fits.

## Behavior

The controller observes the public `ctx.model` for each project/session and also handles `model_select`. After a real mid-session model change, every later `context` event is rewritten. A missed switch event is detected by comparing the current model with the last observed model. If the model or project owner cannot be verified, handoff returns the safe refusal rather than replaying history.

The bounded context contains one continuity prefix followed by the newest complete turns that fit:

1. A newer explicit `/memory checkpoint` wins.
2. Otherwise the latest Pi `compactionSummary` or `branchSummary` message is the deterministic fallback.
3. The current complete turn is mandatory; older complete turns are added newest-first.

The newest user requirement, including qualifications and evidence references in that turn or checkpoint, is therefore retained. Pi 0.85.1 tool calls are assistant `content` blocks whose type is `toolCall`. Calls and `toolResult` messages must form a one-to-one set; missing, orphaned, or duplicate results refuse the handoff. Multi-call loops are kept whole even when results arrive in a different order.

If the continuity prefix, current turn, and provider overhead cannot fit, the handler aborts, notifies, and returns a known safe instruction. Thrown errors are caught because Pi swallows `context` exceptions (fail-open). There is **no** documented cancel-return that proves the HTTP request was prevented; `ctx.abort()` is best-effort. If Pi continues transport, only the safe bounded replacement is eligible, never the original history.

## Budgets

`MemoryExtensionOptions.handoff` configures:

- `maxTokens`: system prompt + explicit tool-schema reserve + selected messages
- `maxBytes`: measured system prompt + serialized selected messages
- `maxMessages`: selected message count
- `toolSchemaReserveTokens`: an explicit reserve because Pi 0.85.1 has no public tool-schema size accessor

The effective system prompt is measured on every request through public `ctx.getSystemPrompt()`. The default reserve is 1,500 tokens; it is a tool-schema reserve, not a fixed estimate of the system prompt. Diagnostics itemize measured system tokens/bytes, tool reserve, message tokens/bytes, and totals. If overhead alone consumes the budget, handoff refuses safely.

## Operational checkpoints

`/memory checkpoint {json}` transactionally writes a maximum 4,000-byte operational record into the `operational_checkpoints` table of the **current project's** `memory.sqlite`. The row is keyed by project and session.

Operational checkpoints never enter documents, chunks, FTS, vectors, the semantic journal, curation, default or all-namespace recall, evaluation evidence, or semantic item counts. Opening a current database remains read-only at schema/ownership validation; the table is created only by normal fresh-schema creation or an explicit schema upgrade.
