import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMemoryHooks } from './extension/hooks.ts';
import { installMemoryTools } from './extension/tools.ts';
import { runGc } from './retention/gc.ts';

export const installMemory = (pi: ExtensionAPI): void => {
  const runtime = installMemoryHooks(pi);
  installMemoryTools(pi, runtime);
  pi.registerCommand('memory', {
    description: 'Inspect or maintain pi-memory: /memory status | replay | rebuild | gc',
    handler: async (args, ctx) => {
      const engine = await runtime.engine();
      const action = args.trim() || 'status';
      const report = action === 'status' ? engine.projection.stats()
        : action === 'replay' ? await engine.replay(false)
        : action === 'rebuild' ? await engine.rebuild()
        : action === 'gc' ? await runGc(engine)
        : undefined;
      if (!report) throw new Error('Usage: /memory status | replay | rebuild | gc');
      ctx.ui.notify(JSON.stringify(report, null, 2), 'info');
    },
  });
};

export default function memoryExtension(pi: ExtensionAPI): void {
  installMemory(pi);
}

export * from './engine.ts';
