import { executeDaemonCommand } from '../src/daemon/cli.ts';

const result = await executeDaemonCommand(process.argv.slice(2));
if (result !== undefined) console.log(JSON.stringify(result, null, 2));
