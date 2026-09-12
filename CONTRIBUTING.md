# Contributing

- Stable release branch: `main`. Integration branch: `develop`.
- Create feature branches from `develop` and target `develop` in normal pull requests.
- Deliver changes through a pull request using `.github/pull_request_template.md`.
- Use English for code, documentation, tests, issues, and pull requests.
- Use strict TypeScript and only APIs documented by Pi 0.85.1.
- Use immutable values: `npm run check` fails on any `let` under `src/`.
- Do not import host internals, start an MCP server, or invoke a second reasoning model.
- Pi's active agent owns extraction, query expansion, reranking, and consolidation decisions.
- Host observations may only receive native provenance from extension event handlers.
- Keep runtime dependencies in `dependencies`; list Pi-provided packages in `peerDependencies`.
- Run `npm run check`, `npm test`, `npm run test:integration`, and `npm pack --dry-run` before review.
- Never push, open or merge a pull request, publish, or deploy without explicit authorization.
