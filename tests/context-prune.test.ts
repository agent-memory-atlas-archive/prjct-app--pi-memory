import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextLine, contextPrune, queueContextPrune } from '../src/extension/context-prune.ts';

test('/memory reaches pi-context-prune on the shared process symbol, and says so when it is absent', () => {
  const key = Symbol.for('prjct.context-prune');
  const space = globalThis as unknown as Record<symbol, unknown>;
  const previous = space[key];
  try {
    delete space[key];
    assert.equal(contextPrune(), undefined);
    assert.match(queueContextPrune({}), /not loaded/);
    const state = { queued: false, ctx: undefined as unknown };
    space[key] = { memory: { queue: (ctx: unknown) => { state.queued = true; state.ctx = ctx; },
      status: () => ({ inContext: 1234, pruned: 800, queued: state.queued }) } };
    const ctx = { hasUI: true };
    assert.match(queueContextPrune(ctx), /Prune queued .* 1\.2k tok in context · 800 pruned · prune queued/);
    assert.equal(state.ctx, ctx, 'the session context goes along so the status line can update');
    assert.equal(contextLine(undefined), 'pi-context-prune not loaded');
  } finally {
    space[key] = previous;
  }
});
