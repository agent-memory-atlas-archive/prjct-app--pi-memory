import type { ToolRenderers } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, type Component } from '@earendil-works/pi-tui';

/**
 * Terminal view of memory_context. Presentation only: the model still gets
 * the full JSON. One row by default, the entries when the row is expanded.
 */

type Theme = Parameters<NonNullable<ToolRenderers['renderCall']>>[1];
type Args = Readonly<{ action?: string; query?: string; entryId?: string; scope?: string; since?: string; until?: string; offset?: number }>;
type Entry = Readonly<{ entryId?: string; timestamp?: string; kind?: string; name?: string; currentSession?: boolean; excerpt?: string }>;
type Details = Readonly<{
  status?: string; scope?: string; match?: string; totalMatches?: number; entries?: readonly Entry[]; nextOffset?: number | null;
  indexing?: string; hint?: string; entryId?: string; kind?: string; timestamp?: string; totalCharacters?: number; text?: string;
}>;

const lines = (render: (width: number) => string[]): Component => ({
  render: width => render(width).map(line => truncateToWidth(line, width, '…')),
  invalidate() {},
});

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const when = (timestamp?: string): string => {
  const date = timestamp ? new Date(timestamp) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const target = (args: Args): string => {
  if (args.action === 'read') return `read ${args.entryId ?? ''}`.trim();
  if (args.action === 'summaries') return 'summaries';
  return args.query ? `search "${flat(args.query)}"` : 'recent entries';
};

const row = (theme: Theme, symbol: string, color: 'accent' | 'success' | 'error' | 'warning', args: Args, meta = ''): string =>
  `${theme.fg(color, symbol)} ${theme.fg('toolTitle', theme.bold('MEMORY'.padEnd(8)))}${theme.fg('toolOutput', target(args))}`
  + (meta ? theme.fg('dim', ` · ${meta}`) : '');

const outcome = (details: Details): string => {
  if (details.status === 'not_found') return 'not found';
  if (details.status === 'ambiguous') return 'several sessions have this id';
  if (details.status === 'unavailable') return 'journal line gone';
  if (details.text !== undefined) return `${details.kind ?? 'entry'} · ${when(details.timestamp)} · ${(details.totalCharacters ?? 0).toLocaleString('en-US')} chars`;
  const total = details.totalMatches ?? details.entries?.length ?? 0;
  const parts = [total === 0 ? 'no matches' : `${total.toLocaleString('en-US')} ${total === 1 ? 'match' : 'matches'}`];
  if (details.match === 'any') parts.push('partial');
  if (details.scope) parts.push(details.scope);
  if (details.indexing) parts.push('still indexing');
  return parts.join(' · ');
};

export const memoryView: ToolRenderers = {
  renderShell: 'self',
  renderCall(args, theme, context) {
    return lines(() => (context.isPartial || !context.executionStarted ? [row(theme, '◆', 'accent', (args ?? {}) as Args)] : []));
  },
  renderResult(result, { expanded }, theme, context) {
    const args = (context.args ?? {}) as Args;
    const details = result.details as Details | undefined;
    if (context.isError || !details) {
      const message = result.content.map(part => (part.type === 'text' ? part.text : '')).join(' ');
      return lines(() => [row(theme, '✕', 'error', args, flat(message) || 'failed')]);
    }
    const failed = details.status === 'not_found' || details.status === 'unavailable' || details.status === 'ambiguous';
    return lines(() => {
      const out = [row(theme, '✓', failed ? 'warning' : 'success', args, outcome(details))];
      if (!expanded) return out;
      if (details.text !== undefined) {
        out.push(...details.text.split('\n').slice(0, 40).map(line => `  ${theme.fg('toolOutput', line)}`));
        return out;
      }
      for (const entry of details.entries ?? []) {
        const source = [when(entry.timestamp), entry.name ? `${entry.kind} ${entry.name}` : entry.kind, entry.currentSession ? 'this session' : '']
          .filter(Boolean).join(' · ');
        out.push(`  ${theme.fg('dim', `${entry.entryId ?? ''}  ${source}`)}`, `    ${theme.fg('toolOutput', flat(entry.excerpt ?? ''))}`);
      }
      if (details.hint) out.push(`  ${theme.fg('dim', details.hint)}`);
      if (details.nextOffset != null) out.push(`  ${theme.fg('dim', `more from offset ${details.nextOffset}`)}`);
      return out;
    });
  },
};
