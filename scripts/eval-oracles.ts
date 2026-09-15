import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scoreOracle, type OracleCase, type OracleHit } from '../src/eval/oracles.ts';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const casesPath = arg('--cases');
if (!casesPath) {
  console.log(JSON.stringify({
    status: 'rejected', passed: false,
    reason: 'eval-oracles requires --cases. Missing cases is not success.',
  }, null, 2));
  process.exit(1);
}
const payload = JSON.parse(await readFile(resolve(casesPath), 'utf8')) as { cases: OracleCase[]; hits: Record<string, OracleHit[]>; retrieval?: Record<string, { status: string; gaps: string[] }> };
const scores = payload.cases.map(kase => scoreOracle(payload.hits[kase.name] ?? [], kase, payload.retrieval?.[kase.name]));
const report = {
  semantic: 'oracle-mechanics',
  note: 'Compares supplied hits to expected statements/citations. Does not call a model.',
  scores,
  passed: scores.every(score => score.passed),
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
