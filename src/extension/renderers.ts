import { Container, Text, type Component } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { SYMBOL, row } from '@prjct.app/pi-tui-kit';

const clean = (text: string): string => text.replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();
const actionOf = (args: unknown): string =>
  args && typeof args === 'object' && 'action' in args && typeof args.action === 'string' ? clean(args.action) : 'call';

/** While a memory call runs its row is the call; the result row replaces it once settled. */
export const renderMemoryCall = (theme: Theme, tool: 'context' | 'record', args: unknown, running: boolean): Component =>
  running ? row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'MEM', target: `${tool} · ${actionOf(args)}`, meta: 'working…' }) : new Container();

const summarizeDetails = (details: unknown): { line: string; full: string[]; failed: boolean } => {
  if (!details || typeof details !== 'object') return { line: String(details), full: [String(details)], failed: false };
  const value = details as Record<string, unknown>;
  const items = Array.isArray(value.items) ? value.items.length : undefined;
  const gaps = Array.isArray(value.gaps) ? value.gaps.length : 0;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const line = [
    status && status !== 'ok' ? status : undefined,
    items !== undefined ? `${items} hit${items === 1 ? '' : 's'}` : undefined,
    gaps ? `${gaps} gap${gaps === 1 ? '' : 's'}` : undefined,
    typeof value.id === 'string' ? value.id : undefined,
    typeof value.standing === 'string' ? value.standing : undefined,
  ].filter(Boolean).join(' · ') || 'ok';
  const full = [
    status ? `status ${status}` : undefined,
    items !== undefined ? `hits ${items}` : undefined,
    gaps ? `gaps ${gaps}` : undefined,
    typeof value.id === 'string' ? `id ${value.id}` : undefined,
    typeof value.standing === 'string' ? `standing ${value.standing}` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return { line, full: full.length ? full : [line], failed: status === 'error' || status === 'failed' };
};

/** One row in the shared grammar; expanded adds the facts under it. */
export const renderMemoryResult = (theme: Theme, tool: 'context' | 'record', args: unknown, details: unknown, expanded: boolean, isError: boolean): Component => {
  const summary = summarizeDetails(details);
  const failed = isError || summary.failed;
  const gap = summary.line.includes('gap');
  const head = row(theme, {
    symbol: failed ? SYMBOL.error : gap ? SYMBOL.attention : SYMBOL.ok,
    tone: failed ? 'error' : gap ? 'warning' : 'success',
    verb: 'MEM', target: `${tool} · ${actionOf(args)}`, meta: clean(summary.line),
  });
  if (!expanded) return head;
  const container = new Container();
  container.addChild(head);
  container.addChild(new Text(theme.fg('dim', summary.full.map(clean).join('\n')), 2, 0));
  return container;
};
