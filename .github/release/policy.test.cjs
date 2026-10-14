const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('./config.cjs');

async function releaseType(messages) {
  const { analyzeCommits } = await import(require.resolve('@semantic-release/commit-analyzer'));
  return analyzeCommits(config.plugins[0][1], {
    commits: messages.map((message, index) => ({ message, hash: String(index).padStart(40, '0') })),
    logger: { log() {} }
  });
}

for (const [message, expected] of [
  ['fix: repair image preview', 'patch'],
  ['perf: reduce redraws', 'patch'],
  ['feat: add a workflow command', 'minor'],
  ['feat!: replace the command interface', 'major'],
  ['fix: change behavior\n\nBREAKING CHANGE: remove the previous option', 'major'],
  ['docs!: change the supported setup', 'major'],
  ['docs: update the npm description', 'patch'],
  ['ci(release): enable trusted publishing', 'patch'],
  ['chore(deps): update runtime dependencies', 'patch'],
  ['test: add a regression case', null],
  ['chore(release): 0.1.4 [skip ci]', null]
]) {
  test(message.split('\n')[0], async () => {
    assert.equal(await releaseType([message]), expected);
  });
}

test('the highest required bump wins across merged commits', async () => {
  assert.equal(await releaseType(['fix: one', 'feat: two', 'docs: three']), 'minor');
});


test('already-published releases require an ancestor tag, identical packed files and registry version', () => {
  const { alreadyPublished } = require('./already-published.cjs');
  const manifest = { name: '@prjct.app/fixture', version: '0.1.0' };
  const calls = [];
  const run = args => { calls.push(args); return args[1] === 'pack' ? '[{"files":[{"path":"index.ts"},{"path":"package.json"}]}]' : args[1] === 'view' ? '"0.1.0"' : ''; };
  assert.equal(alreadyPublished(manifest, run), true);
  assert.ok(calls.some(args => args.includes('index.ts') && args.includes('--exit-code')));
  for (const fail of ['merge-base', 'diff', 'view']) assert.equal(alreadyPublished(manifest, args => { if (args[1] === fail) throw new Error('unverified'); return run(args); }), false);
  assert.equal(alreadyPublished(manifest, args => args[1] === 'view' ? '"0.0.9"' : run(args)), false);
});


test('npm publication happens only in the Release workflow through trusted publishing', () => {
  const { readdirSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const manifest = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  assert.match(manifest.scripts.prepublishOnly, /GITHUB_ACTIONS/);
  const workflows = join(__dirname, '../workflows');
  for (const file of readdirSync(workflows)) {
    assert.doesNotMatch(readFileSync(join(workflows, file), 'utf8'), /NPM_TOKEN|NODE_AUTH_TOKEN|npm publish/, file);
  }
  assert.match(readFileSync(join(workflows, 'release.yml'), 'utf8'), /id-token: write/);
});
