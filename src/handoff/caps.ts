/**
 * Source caps for noisy tool output. Grep and CI logs regularly hit Pi's 50KB
 * limit (~12.8k tokens each) and were then re-sent on every later call. Bash
 * keeps its head and, mostly, its tail (failures print last); grep/find keep
 * their first matches. The full text is saved to a file the model can read with
 * offset/limit or grep. `read` is never capped: explicit document reads stay whole.
 */
export type OutputCapPolicy = Readonly<{
  enabled: boolean;
  /** Bash output above this many characters is capped. */
  bashChars: number;
  bashHeadChars: number;
  /** Grep/find output above this many characters is capped. */
  searchChars: number;
}>;

export const DEFAULT_OUTPUT_CAP_POLICY: OutputCapPolicy = {
  enabled: true, bashChars: 16_000, bashHeadChars: 4_000, searchChars: 12_000,
};

const CAPPED_TOOLS = new Set(['bash', 'grep', 'find']);

export const isCappedTool = (toolName: string): boolean => CAPPED_TOOLS.has(toolName);

const safeCut = (text: string, index: number): number => {
  const code = text.charCodeAt(index - 1);
  return index > 0 && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
};

const countLines = (text: string): number => text ? text.split('\n').length : 0;

/** Returns the capped text, or undefined when the output is within limits. */
export const capToolOutput = (toolName: string, text: string, fullOutputPath: string,
  policy: OutputCapPolicy = DEFAULT_OUTPUT_CAP_POLICY): string | undefined => {
  if (!policy.enabled || !isCappedTool(toolName)) return undefined;
  const pointer = `full output (${text.length} chars, ${countLines(text)} lines) saved to ${fullOutputPath}; use read with offset/limit or grep on it if you need more`;
  if (toolName === 'bash') {
    if (text.length <= policy.bashChars) return undefined;
    const head = safeCut(text, policy.bashHeadChars);
    const tailStart = safeCut(text, text.length - (policy.bashChars - policy.bashHeadChars));
    return `${text.slice(0, head)}\n\n[pi-memory: ${countLines(text.slice(head, tailStart))} middle lines omitted; ${pointer}]\n\n${text.slice(tailStart)}`;
  }
  if (text.length <= policy.searchChars) return undefined;
  const cut = text.lastIndexOf('\n', policy.searchChars);
  const end = cut > policy.searchChars / 2 ? cut : safeCut(text, policy.searchChars);
  return `${text.slice(0, end)}\n\n[pi-memory: ${countLines(text.slice(end))} more lines omitted; narrow the pattern or path, or see the ${pointer}]`;
};
