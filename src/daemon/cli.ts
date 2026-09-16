import { loadDaemonConfig, type DaemonConfig } from './config.ts';
import { announceAlive, daemonStatus, startDaemon, stopDaemon } from './lifecycle.ts';
import { runLoop, type CycleReport } from './worker.ts';

const flag = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

export const parseDaemonArgs = (argv: readonly string[]): { command: string; config: Partial<DaemonConfig> } => {
  const command = argv[0] ?? 'status';
  const interval = flag(argv, '--interval-ms');
  return {
    command,
    config: {
      ...(flag(argv, '--home') ? { home: flag(argv, '--home') } : {}),
      ...(flag(argv, '--provider') ? { provider: flag(argv, '--provider') } : {}),
      ...(flag(argv, '--model') ? { model: flag(argv, '--model') } : {}),
      ...(interval && Number(interval) > 0 ? { intervalMs: Number(interval) } : {}),
    },
  };
};

const logCycle = (report: CycleReport): void => {
  // Identifiers and counters only — never prompts, source bodies, or model text.
  console.error(JSON.stringify({ event: 'cycle', ...report, at: new Date().toISOString() }));
};

export const executeDaemonCommand = async (argv: readonly string[]): Promise<unknown> => {
  const parsed = parseDaemonArgs(argv);
  const config = await loadDaemonConfig(parsed.config);
  if (parsed.command === 'status') return daemonStatus(config.home);
  if (parsed.command === 'stop') return stopDaemon(config.home);
  if (parsed.command === 'start') return startDaemon(config);
  if (parsed.command === 'run') {
    const token = process.env.PI_MEMORY_DAEMON_TOKEN;
    if (!token) throw new Error('PI_MEMORY_DAEMON_TOKEN is required for daemon run.');
    await announceAlive(config.home, token);
  }
  if (parsed.command === 'once' || parsed.command === 'run') {
    const controller = new AbortController();
    const onStop = (): void => controller.abort();
    process.once('SIGTERM', onStop);
    process.once('SIGINT', onStop);
    try {
      const report = await runLoop({ config, owner: `daemon_${process.pid}`, signal: controller.signal }, parsed.command === 'once');
      logCycle(report);
      return report;
    } finally {
      process.removeListener('SIGTERM', onStop);
      process.removeListener('SIGINT', onStop);
    }
  }
  throw new Error('Usage: memory-daemon once|start|stop|status|run [--home path] [--provider id] [--model id]');
};
