# Model-switch context handoff

Pi 0.85.1 `context` can replace `AgentMessage[]` before each LLM call. `model_select` fires on set/cycle/restore. This module does **not** start the memory daemon or run hidden analysis. It cancels automatic threshold/overflow compaction before summarizer inference; explicit manual `/compact` remains a paid host operation.

Provider prompt cache (Anthropic/OpenAI cache keys) is **not** pi-memory. Handoff only rewrites the messages Pi sends; it does not claim to flush provider caches. Cache notices remain ordinary retained messages when their complete turn fits.

## Behavior

Every `context` event is budgeted, including before the first model switch. A never-initialized checkout uses a transient window without registry/database writes. Durable memory supplies an optional checkpoint, not permission to optimize context. A present binding is validated; after successful authority opening, a missing or changed binding returns the safe refusal. A pending open is not proof of prior ownership. Concurrent context events await activation and stale session completions cannot activate a replacement session.

The session-local window preserves message bytes while they fit. Once full, it evicts whole older turns toward 75% of the limits to leave growth room. If one agent turn grows across many tool rounds, it keeps the operator request and newest complete tool rounds that fit instead of aborting merely because earlier rounds accumulated. Tool calls and results remain atomic. A watermark prevents discarded whole turns from reappearing when overhead decreases; host history replacement resets that watermark. Identical recall blocks keep their first retained copy, preserving the cacheable prefix, while changed recall is appended. Dedupe is based on the retained context, so evicted facts can be re-delivered. No provider cache key, retention setting or routing identifier is changed.

These are cache-friendly inputs, not guaranteed cache hits: provider/model changes, cache expiry, tool/system changes and necessary eviction can still incur input charges. System/tool overhead is not removed. If the newest complete tool round exceeds the hard budget, oversized strings are truncated in place before anything is refused: first tool-result/custom/bash output text, then image blocks (replaced by a text note), then assistant text and tool-call string arguments. One shared per-field cap (minimum 512 chars) is binary-searched so the largest strings are cut first and the pack uses the available room; each cut keeps the head and tail with an explicit omission marker. No message is removed, so call/result pairs stay atomic, and signed thinking blocks are never modified. The operator request, explicit checkpoint and Pi summaries are never clipped. Continuation refuses only if overhead, the request, or the message count still cannot fit after truncation; it never purchases a summary. A truncated pack is not further compacted toward 75%. The host session transcript is not deleted or summarized by local selection.

The bounded context contains one continuity prefix followed by the newest complete turns that fit:

1. A newer explicit `/memory checkpoint` wins.
2. Otherwise the latest Pi `compactionSummary` or `branchSummary` message is the deterministic fallback.
3. The current user request and newest complete tool round are mandatory; additional current-turn tool rounds and older complete turns are added newest-first.

The newest user requirement, including qualifications and evidence references in that request or checkpoint, is therefore retained. Pi 0.85.1 tool calls are assistant `content` blocks whose type is `toolCall`. Calls and `toolResult` messages must form a one-to-one set; missing, orphaned, or duplicate results refuse the handoff. Multi-call loops are kept whole even when results arrive in a different order.

If the continuity prefix, current request, newest complete tool round (after truncation), and provider overhead cannot fit, the handler aborts, notifies, and returns a known safe instruction only if that instruction also fits. Otherwise it returns no messages. Thrown errors are caught because Pi swallows `context` exceptions (fail-open). There is **no** documented cancel-return that proves the HTTP request was prevented; `ctx.abort()` is best-effort. If Pi continues transport, the original history is never eligible. Fixed system/tool overhead can itself exceed the budget and cannot be removed safely by this message handler: this is not a guaranteed total-cost or transport-cancellation boundary.

## Budgets

The default ceiling is 16,000 estimated tokens, 262,144 bytes, and 48 messages, including measured system/tool overhead. `MemoryExtensionOptions.handoff` configures:

- `maxTokens`: system prompt + explicit tool-schema reserve + selected messages
- `maxBytes`: measured system prompt + active tool definitions + serialized selected messages
- `maxMessages`: selected message count
- `toolSchemaReserveTokens`: fallback reserve when active tool definitions are unavailable

The effective system prompt is measured on every request through public `ctx.getSystemPrompt()`. Active definitions from `getAllTools()`/`getActiveTools()` replace the default 1,500-token fallback reserve. Token counts are estimates, not provider billing telemetry; serialization by the provider or later extensions can change actual request size. Diagnostics itemize system tokens/bytes, tool reserve, message tokens/bytes, and totals. If overhead alone consumes the budget, handoff refuses and returns no messages.

## Operational checkpoints

`/memory checkpoint {json}` transactionally writes a maximum 4,000-byte operational record into the `operational_checkpoints` table of the **current project's** `memory.sqlite`. The row is keyed by project and session.

Operational checkpoints never enter documents, chunks, FTS, vectors, the semantic journal, curation, default or all-namespace recall, evaluation evidence, or semantic item counts. Opening a current database remains read-only at schema/ownership validation; the table is created only by normal fresh-schema creation or an explicit schema upgrade.
