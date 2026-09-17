import type { HandoffMessage } from './turns.ts';

/**
 * Last resort before refusing a handoff: cap oversized strings in the mandatory
 * pack instead of aborting healthy work. Messages are never removed, so tool
 * call/result pairs stay atomic. Tiers widen from tool output to assistant
 * tool-call arguments; within a tier one shared cap is binary-searched, so the
 * largest strings are cut first. The operator request, checkpoint and summaries
 * are never clipped: an oversized request still refuses.
 */

const MIN_KEEP = 512;
const MARKER_SLACK = 128;
const IMAGE_OMITTED = '[pi-memory handoff: image omitted to fit the context budget]';

type Tier = 'output' | 'images' | 'assistant';
const STAGES: readonly (readonly Tier[])[] = [
  ['output'],
  ['output', 'images'],
  ['output', 'images', 'assistant'],
];

type Stats = { fields: number };

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

const capText = (text: string, keep: number, stats: Stats): string => {
  if (text.length <= keep + MARKER_SLACK) return text;
  const rawHead = Math.ceil(keep * 0.6);
  const head = rawHead > 0 && isHighSurrogate(text.charCodeAt(rawHead - 1)) ? rawHead - 1 : rawHead;
  const rawTail = text.length - (keep - rawHead);
  const tail = rawTail < text.length && isLowSurrogate(text.charCodeAt(rawTail)) ? rawTail + 1 : rawTail;
  stats.fields += 1;
  return `${text.slice(0, head)}\n…[pi-memory handoff: ${tail - head} of ${text.length} chars omitted to fit the context budget; re-run with a narrower scope if the omitted part matters]…\n${text.slice(tail)}`;
};

/** Returns the original array when no element changed, preserving identity for the window watermark. */
const mapSame = <T>(items: readonly T[], map: (item: T) => T): readonly T[] => {
  const mapped = items.map(map);
  return mapped.every((item, index) => item === items[index]) ? items : mapped;
};

const capValue = (value: unknown, keep: number, stats: Stats): unknown => {
  if (typeof value === 'string') return capText(value, keep, stats);
  if (Array.isArray(value)) return mapSame(value, item => capValue(item, keep, stats));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const mapped = entries.map(([key, item]) => [key, capValue(item, keep, stats)] as const);
  return mapped.every(([, item], index) => item === entries[index]![1]) ? value : Object.fromEntries(mapped);
};

type Block = Readonly<{ type?: unknown; text?: unknown; arguments?: unknown }>;

const capContent = (content: unknown, keep: number, stats: Stats,
  mapBlock: (block: Block) => Block): unknown => {
  if (typeof content === 'string') return capText(content, keep, stats);
  if (!Array.isArray(content)) return content;
  return mapSame(content as Block[], block => (block && typeof block === 'object' ? mapBlock(block) : block));
};

const capTextBlock = (block: Block, keep: number, stats: Stats): Block => {
  if (block.type !== 'text' || typeof block.text !== 'string') return block;
  const text = capText(block.text, keep, stats);
  return text === block.text ? block : { ...block, text };
};

const withField = <K extends string>(message: HandoffMessage, key: K, value: unknown): HandoffMessage =>
  (message as Record<string, unknown>)[key] === value ? message : { ...message, [key]: value } as HandoffMessage;

const capMessage = (message: HandoffMessage, tiers: ReadonlySet<Tier>, keep: number, stats: Stats): HandoffMessage => {
  switch (message.role) {
    case 'toolResult':
    case 'tool':
    case 'custom': {
      if (!tiers.has('output')) return message;
      const dropImages = tiers.has('images');
      return withField(message, 'content', capContent(message.content, keep, stats, block =>
        dropImages && block.type === 'image' ? { type: 'text', text: IMAGE_OMITTED } : capTextBlock(block, keep, stats)));
    }
    case 'bashExecution': {
      if (!tiers.has('output')) return message;
      const output = (message as { output?: unknown }).output;
      return typeof output === 'string' ? withField(message, 'output', capText(output, keep, stats)) : message;
    }
    case 'assistant': {
      // Signed thinking blocks are left untouched; changing them invalidates the signature.
      if (!tiers.has('assistant')) return message;
      return withField(message, 'content', capContent(message.content, keep, stats, block => {
        if (block.type === 'toolCall' && block.arguments !== undefined) {
          const args = capValue(block.arguments, keep, stats);
          return args === block.arguments ? block : { ...block, arguments: args };
        }
        return capTextBlock(block, keep, stats);
      }));
    }
    default:
      return message;
  }
};

const capPack = (messages: readonly HandoffMessage[], tiers: ReadonlySet<Tier>, keep: number) => {
  const stats: Stats = { fields: 0 };
  return { messages: messages.map(message => capMessage(message, tiers, keep, stats)), fields: stats.fields };
};

export type ShrinkResult = Readonly<{ messages: readonly HandoffMessage[]; keep: number; truncatedFields: number }>;

export const shrinkToFit = (messages: readonly HandoffMessage[],
  fits: (messages: readonly HandoffMessage[]) => boolean): ShrinkResult | undefined => {
  const upper = Math.max(MIN_KEEP, JSON.stringify(messages).length);
  for (const stage of STAGES) {
    const tiers = new Set(stage);
    if (!fits(capPack(messages, tiers, MIN_KEEP).messages)) continue;
    const range = { lo: MIN_KEEP, hi: upper };
    while (range.lo < range.hi) {
      const mid = Math.ceil((range.lo + range.hi) / 2);
      if (fits(capPack(messages, tiers, mid).messages)) range.lo = mid;
      else range.hi = mid - 1;
    }
    const best = capPack(messages, tiers, range.lo);
    return { messages: best.messages, keep: range.lo, truncatedFields: best.fields };
  }
  return undefined;
};
