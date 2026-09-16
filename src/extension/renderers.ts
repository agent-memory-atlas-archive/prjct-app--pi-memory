import { Text, truncateToWidth } from '@earendil-works/pi-tui';

export const oneLine = (text: string) => ({
  invalidate() {},
  render(width: number) { return [truncateToWidth(text.replace(/\s+/g, ' '), width)]; },
});

export const renderMemoryCall = (name: string, args: unknown) =>
  oneLine(`▸ ${name} · ${JSON.stringify(args).slice(0, 160)}`);

export const renderMemoryResult = (label: string, details: unknown, expanded: boolean) => {
  const text = `${label} · ${JSON.stringify(details)}`;
  return expanded ? new Text(text, 1, 0) : oneLine(`▸ ${text.slice(0, 180)} · Ctrl+O details`);
};
