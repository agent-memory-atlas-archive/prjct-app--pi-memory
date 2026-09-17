# Contributing

- Stable release branch: `main`. Integration branch: `develop`.
- Create feature branches from `develop` and target `develop` in normal pull requests.
- Deliver changes through a pull request using `.github/pull_request_template.md`.
- Use English for code, documentation, tests, issues, and pull requests.
- Use strict TypeScript and only APIs documented by Pi 0.85.1.
- Use immutable values: `npm run check` fails on any `let` under `src/`.
- Do not import host internals or start an MCP server. The Pi extension must not launch hidden background model calls or start a daemon implicitly.
- An explicitly configured standalone memory daemon may perform autonomous extraction, synthesis, consolidation, and freshness review while Pi is closed. It must enforce durable job state, scoped access, revision checks, deadlines, and model/cost budgets.
- Pi's active agent owns interactive query expansion, reranking, and final answers. Background analysis persists curated knowledge and provenance references, not raw source bodies or model transcripts.
- Daemon implementation is not authorization to install or activate a persistent service; activation requires explicit user authorization.
- Host observations may only receive native provenance from extension event handlers.
- Keep runtime dependencies in `dependencies`; list Pi-provided packages in `peerDependencies`.
- Run `npm run check`, `npm test`, `npm run test:integration`, and `npm pack --dry-run` before review.
- Build the compiled local copy Pi loads with `npm run build:pi`. It writes `~/.pi/agent/builds/<package>` outside the repository, because compiled code inside it would load the repository's development copy of Pi instead of the host's.
- Never push, open or merge a pull request, publish, or deploy without explicit authorization.
