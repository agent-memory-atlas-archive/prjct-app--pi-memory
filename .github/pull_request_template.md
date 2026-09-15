## Summary

## Branch flow

- [ ] Targets `develop` and is based on the latest `develop`

## Pi-native architecture

- [ ] Uses only documented Pi 0.85.1 APIs
- [ ] Starts no MCP server or implicit daemon/model loop from the Pi extension
- [ ] Background analysis is an explicit, bounded standalone daemon that works with Pi closed
- [ ] Persists curated knowledge and source references, not raw source bodies or model transcripts
- [ ] Keeps host provenance separate from agent reports

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] `npm run eval -- --suite tests/fixtures/retrieval-gold.jsonl`
- [ ] `npm pack --dry-run --ignore-scripts`

## Daemon verification (when affected)

- [ ] Source changes are processed with no interactive Pi session
- [ ] Unchanged inputs incur no repeated analysis/embedding calls
- [ ] Restart, competing claims, obsolete results, budgets, and failures are covered
- [ ] No persistent service was installed or activated without explicit authorization

## Limitations and manual verification
