## Summary

## Branch flow

- [ ] Targets `develop` and is based on the latest `develop`

## Pi-native architecture

- [ ] Uses only documented Pi 0.85.1 APIs
- [ ] Starts no daemon, MCP server, or second reasoning model
- [ ] Keeps host provenance separate from agent reports

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] `npm run eval -- --suite tests/fixtures/retrieval-gold.jsonl`
- [ ] `npm pack --dry-run --ignore-scripts`

## Limitations and manual verification
