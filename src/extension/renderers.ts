import { Text, truncateToWidth } from '@earendil-works/pi-tui';

export const oneLine = (text: string) => ({
  invalidate() {},
  render(width: number) { return [truncateToWidth(text.replace(/\s+/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''), width)]; },
});

export const renderMemoryCall = (name: string, args: unknown) => {
  const action = args && typeof args === 'object' && 'action' in args && typeof args.action === 'string' ? args.action : 'call';
  return oneLine(`◆ ${name} · ${action}`);
};

const summarizeDetails = (details: unknown): { line: string; full: string } => {
  if (!details || typeof details !== 'object') return { line: String(details), full: String(details) };
  const value = details as Record<string, unknown>;
  const items = Array.isArray(value.items) ? value.items.length : undefined;
  const gaps = Array.isArray(value.gaps) ? value.gaps.length : 0;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const line = [
    status,
    items !== undefined ? `${items} hits` : undefined,
    gaps ? `${gaps} gaps` : undefined,
    typeof value.id === 'string' ? value.id : undefined,
    typeof value.standing === 'string' ? value.standing : undefined,
  ].filter(Boolean).join(' · ') || 'ok';
  const full = [
    status ? `status ${status}` : undefined,
    items !== undefined ? `hits ${items}` : undefined,
    gaps ? `gaps ${gaps}` : undefined,
    typeof value.id === 'string' ? `id ${value.id}` : undefined,
    typeof value.standing === 'string' ? `standing ${value.standing}` : undefined,
  ].filter(Boolean).join('\n') || line;
  return { line, full };
};

export const renderMemoryResult = (label: string, details: unknown, expanded: boolean) => {
  const summary = summarizeDetails(details);
  return expanded ? new Text(`${label}\n${summary.full}`, 1, 0) : oneLine(`◆ ${label} · ${summary.line}`);
};
