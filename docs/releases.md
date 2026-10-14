# Automatic releases

Merging a releasable change into `main` starts the **Release** workflow. It checks TypeScript, runs the tests, and checks the package contents before publishing.

The workflow uses semantic-release to calculate the version, update `package.json`, `package-lock.json` and `CHANGELOG.md`, create a `vX.Y.Z` tag, publish to npm, and create a GitHub release. Release-tool dependencies are locked separately under `.github/release/` and are not installed with the extension.

## Commit messages

- `fix:` and `perf:` publish a patch version.
- `feat:` publishes a minor version.
- A `BREAKING CHANGE:` footer or a conventional `!` marker publishes a major version.
- `docs:`, `refactor:`, `build:`, `ci(release):`, and `chore(deps):` publish a patch version.
- Other changes, such as tests alone, do not publish a version.

Use these prefixes on commits. When squash merging, use a conventional prefix in the pull request title. Let the workflow manage release versions instead of editing the version by hand.

## Authentication

npm trusts this repository's `.github/workflows/release.yml` through GitHub Actions OIDC. No npm token or interactive one-time password is needed for each release. The workflow is restricted to `main`; it uses GitHub's short-lived repository token to write the version commit, tag, and release. Private repositories do not produce npm provenance attestations.

The corresponding npm trusted publisher must use organization `prjct-app`, this repository's name, workflow filename `release.yml`, no environment name, and permission to publish directly with `npm publish`.

Never run `npm publish` by hand: `prepublishOnly` refuses outside GitHub Actions, and no npm token is stored in the repository. If a release fails, fix the workflow or the trusted publisher and run it again.

## Preview and recovery

Run **Release** from the Actions tab on `main` with `dry_run` enabled to preview the next version and release notes. No version commit, tag, npm publication, or GitHub release is created by a dry run.

Runs are serialized and an outdated checkout is skipped. Never cancel a run during publication. If a run fails, inspect its logs and the existing npm version and GitHub tag before retrying: publication is not a transaction across both services. Do not delete a published version or move an existing release tag to recover.

References: [semantic-release](https://semantic-release.gitbook.io/semantic-release/), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
