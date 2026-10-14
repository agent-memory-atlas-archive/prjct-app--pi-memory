module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [require.resolve("@semantic-release/commit-analyzer"), {
      preset: "conventionalcommits",
      releaseRules: [
        { breaking: true, release: "major" },
        { type: "docs", release: "patch" },
        { type: "refactor", release: "patch" },
        { type: "build", release: "patch" },
        { type: "ci", scope: "release", release: "patch" },
        { type: "chore", scope: "deps", release: "patch" }
      ]
    }],
    [require.resolve("@semantic-release/release-notes-generator"), { preset: "conventionalcommits" }],
    [require.resolve("@semantic-release/changelog"), { changelogFile: "CHANGELOG.md" }],
    [require.resolve("@semantic-release/npm"), { npmPublish: true }],
    [require.resolve("@semantic-release/git"), {
      assets: ["package.json", "package-lock.json", "CHANGELOG.md"],
      message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
    }],
    [require.resolve("@semantic-release/github"), {
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false
    }]
  ]
};
