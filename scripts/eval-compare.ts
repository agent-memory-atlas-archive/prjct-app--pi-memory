import { runCompareCli } from '../src/eval/cli.ts';

const report = await runCompareCli(process.argv);
console.log(JSON.stringify(report, null, 2));
if (report.status === 'blocked') process.exitCode = 2;
else if (!report.passed) process.exitCode = 1;
