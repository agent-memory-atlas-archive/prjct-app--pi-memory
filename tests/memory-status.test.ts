import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStatusLine } from '../src/extension/digest.ts';

const digest = (lines: number) => ({
  block: `<project_memory trust="untrusted">\nheader\n${Array.from({ length: lines }, (_, index) => `- fact: memory ${index}`).join('\n')}\n</project_memory>`,
  covered: new Set<string>(), complete: false,
});

test('the memory status says what the model has, in words', () => {
  assert.equal(memoryStatusLine(digest(12), 40, 2), 'memory · 12 of 40 memories in context · 2 recalled for this prompt');
  assert.equal(memoryStatusLine(digest(3), 3, 0), 'memory · 3 memories in context');
  assert.equal(memoryStatusLine(digest(1), 1, 0), 'memory · 1 memory in context');
  assert.equal(memoryStatusLine({ covered: new Set(), complete: false }, 5, 1), 'memory · 0 of 5 memories in context · 1 recalled for this prompt');
  assert.equal(memoryStatusLine({ covered: new Set(), complete: true }, 0, 0), undefined, 'no memory, no line');
});
