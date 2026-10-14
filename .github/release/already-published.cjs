const { execFileSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const run = (args) => execFileSync(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function alreadyPublished(manifest, invoke = run) {
  try {
    const tag = `v${manifest.version}`;
    invoke(['git', 'merge-base', '--is-ancestor', tag, 'HEAD']);
    const [packed] = JSON.parse(invoke(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts']));
    invoke(['git', 'diff', '--exit-code', tag, 'HEAD', '--', ...packed.files.map(file => file.path)]);
    return JSON.parse(invoke(['npm', 'view', `${manifest.name}@${manifest.version}`, 'version', '--json'])) === manifest.version;
  } catch { return false; }
}
module.exports = { alreadyPublished };
if (require.main === module) {
  const exists = alreadyPublished(JSON.parse(readFileSync('package.json', 'utf8')));
  appendFileSync(process.env.GITHUB_OUTPUT, `exists=${exists}\n`);
  if (exists) console.log('This exact package content is already tagged and published to npm.');
}
