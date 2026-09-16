import type { Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import type { CurationStats } from '../curation/types.ts';
import type { SourceSyncResult } from '../sources/registry.ts';
import type { SyncDecision } from '../sources/schedule.ts';
import type { SyncRun } from '../storage/projection.ts';

export type MemoryPanelKind = 'status' | 'sources' | 'sync' | 'result' | 'error';

export type MemoryPanelModel = Readonly<{
  title: string;
  scope: string;
  kind: MemoryPanelKind;
  metrics: readonly Readonly<{ label: string; value: string }>[];
  rows: readonly Readonly<{ id: string; cells: readonly string[] }>[];
  error?: string;
  footer: string;
}>;

export type MemoryPresenter = Readonly<{
  hasUI?: boolean;
  mode?: string;
  ui: Readonly<{
    notify(message: string, level?: 'info' | 'warning' | 'error'): void;
    custom?<T>(factory: (tui: { requestRender(): void }, theme: Theme, keys: unknown, done: (value: T) => void) => Component,
      options?: Readonly<{
        overlay?: boolean;
        overlayOptions?: Readonly<Record<string, unknown>>;
        onHandle?: (handle: { focus(): void }) => void;
      }>): Promise<T>;
  }>;
}>;

const FOOTER = 'esc/enter close';
const MAX_LINES = 22;
const sanitize = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
const cell = (text: string, width: number): string => truncateToWidth(text, Math.max(1, width), '…', true);
const paint = (theme: Theme | undefined, slot: 'accent' | 'muted' | 'dim' | 'error' | 'warning' | 'success' | 'text' | 'borderAccent',
  text: string): string => theme ? theme.fg(slot, text) : text;
const emphasize = (theme: Theme | undefined, text: string): string => theme ? theme.bold(text) : text;
const bytes = (value: number): string => value >= 1024 ? `${Math.round(value / 1024)}KiB` : `${value}B`;
const amount = (value: string): number => {
  const match = value.match(/^[0-9]+/u);
  if (match) return Number(match[0]);
  const token = value.trim().toLocaleLowerCase();
  if (['yes', 'ok', 'true', 'initialized', 'ready'].includes(token)) return 1;
  if (['no', 'fail', 'failed', 'error', 'false', 'none'].includes(token)) return 0;
  return token ? 1 : 0;
};
const pair = (text: string): Readonly<{ label: string; value: string }> | undefined => {
  const match = sanitize(text).trim().match(/^([A-Za-z][\w.-]*)\s+(.+)$/u);
  return match?.[1] && match[2] ? { label: match[1], value: match[2] } : undefined;
};
const fillBar = (value: number, peak: number, width: number): string => {
  const filled = width <= 0 || peak <= 0 ? 0 : Math.max(0, Math.min(width, Math.round((Math.max(0, value) / peak) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
};
const rowMark = (row: MemoryPanelModel['rows'][number]): string => {
  const blob = row.cells.join(' ').toLocaleLowerCase();
  if (row.id === 'verdict') return '◆';
  if (blob.includes('gap') || blob.includes('fail')) return '✗';
  if (blob.includes('yes') || blob.includes('queue')) return '◆';
  if (blob.includes('idle') || /(^| )no( |$)/u.test(blob)) return '○';
  return '●';
};
const total = (results: readonly SourceSyncResult[], key: Exclude<keyof SourceSyncResult, 'adapter' | 'scope' | 'gaps'>): number =>
  results.reduce((sum, item) => sum + item[key], 0);

export const panelDismissed = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return name === 'AbortError' || message === 'Operation aborted' || message === 'The operation was aborted';
};

const syncVerdict = (results: readonly SourceSyncResult[]): string => {
  const queued = total(results, 'queued');
  const indexed = total(results, 'indexed');
  const scanned = total(results, 'discovered');
  if (results.some(item => item.gaps.length > 0)) return 'source gap — fingerprints kept';
  if (queued) return `queued ${queued} for the daemon`;
  if (indexed) return `indexed ${indexed} new`;
  if (scanned) return 'no new fingerprints';
  return 'nothing scanned';
};

const headerRule = (title: string, scope: string, width: number, theme?: Theme): string => {
  const head = `${paint(theme, 'accent', '╭─')}${paint(theme, 'accent', emphasize(theme, ` ${sanitize(title)} `))}`;
  const tail = `${scope ? paint(theme, 'dim', ` ${sanitize(scope)} `) : ''}${paint(theme, 'accent', '╮')}`;
  const fill = Math.max(0, width - visibleWidth(head) - visibleWidth(tail));
  return cell(`${head}${paint(theme, 'accent', '─'.repeat(fill))}${tail}`, width);
};

const footerRule = (width: number, theme?: Theme): string =>
  cell(paint(theme, 'accent', `╰${'─'.repeat(Math.max(0, width - 2))}╯`), width);

const boxed = (content: string, width: number, theme?: Theme): string => {
  const edge = paint(theme, 'accent', '│');
  const inner = Math.max(1, width - visibleWidth(edge) * 2);
  return `${edge}${cell(content, inner)}${edge}`;
};

const tile = (item: MemoryPanelModel['metrics'][number], peak: number, width: number, theme?: Theme): readonly [string, string, string] => {
  const title = cell(` ${sanitize(item.label)} ${sanitize(item.value)} `, width - 2);
  const bar = fillBar(amount(item.value), peak, Math.max(3, width - 4));
  const tone = amount(item.value) > 0 ? 'success' : 'dim';
  return [
    paint(theme, 'accent', `╭${title}╮`),
    `${paint(theme, 'accent', '│ ')}${paint(theme, tone, cell(bar, width - 4))}${paint(theme, 'accent', ' │')}`,
    paint(theme, 'accent', `╰${'─'.repeat(Math.max(0, width - 2))}╯`),
  ];
};

const metricBoard = (metrics: MemoryPanelModel['metrics'], width: number, theme?: Theme): readonly string[] => {
  if (!metrics.length) return [];
  const peak = Math.max(1, ...metrics.map(item => amount(item.value)));
  const gap = 1;
  const minTile = 14;
  if (width < metrics.length * minTile + gap * Math.max(0, metrics.length - 1)) {
    return metrics.map(item => cell(
      `${paint(theme, 'muted', sanitize(item.label))} ${paint(theme, 'accent', emphasize(theme, sanitize(item.value)))}  ${paint(theme, amount(item.value) > 0 ? 'success' : 'dim', fillBar(amount(item.value), peak, 8))}`,
      width,
    ));
  }
  const tileW = Math.min(24, Math.max(minTile, Math.floor((width - gap * (metrics.length - 1)) / metrics.length)));
  const tiles = metrics.map(item => tile(item, peak, tileW, theme));
  return [0, 1, 2].map(row => cell(tiles.map(item => item[row]).join(' '), width));
};

const listed = (rows: MemoryPanelModel['rows'], width: number, theme?: Theme): readonly string[] => {
  const visible = rows.filter(row => row.id !== 'head').slice(0, 10);
  const extra = rows.filter(row => row.id !== 'head').length > 10
    ? [paint(theme, 'dim', `+${rows.filter(row => row.id !== 'head').length - 10} more`)]
    : [];
  return [...visible.map(row => {
    const mark = rowMark(row);
    const slot = mark === '✗' ? 'error' : mark === '◆' ? 'warning' : mark === '●' ? 'success' : 'muted';
    return `${paint(theme, slot, mark)}  ${paint(theme, row.id === 'verdict' ? 'text' : 'muted', sanitize(row.cells.join('  ')))}`;
  }), ...extra].map(line => cell(line, width));
};

export const formatPanel = (model: MemoryPanelModel, width: number, theme?: Theme): string[] => {
  const outer = Math.max(16, width);
  const framed = outer >= 36;
  const inner = framed ? Math.max(12, outer - 2) : outer;
  const body = [
    framed ? '' : undefined,
    ...metricBoard(model.metrics, inner, theme),
    model.metrics.length && model.rows.some(row => row.id !== 'head') ? '' : undefined,
    ...listed(model.rows, inner, theme),
    model.error ? paint(theme, 'error', `✗  error  ${sanitize(model.error)}`) : undefined,
    framed || model.footer ? '' : undefined,
    model.footer ? paint(theme, 'dim', sanitize(model.footer)) : undefined,
  ].flatMap(line => line === undefined ? [] : [typeof line === 'string' && line.length === 0 ? cell('', inner) : cell(line, inner)]);
  const card = framed
    ? [
      headerRule(model.title, model.scope, outer, theme),
      ...body.map(line => boxed(line, outer, theme)),
      footerRule(outer, theme),
    ]
    : [
      paint(theme, 'accent', emphasize(theme, `◆ ${sanitize(model.title)}`)) + (model.scope ? paint(theme, 'dim', `  ${sanitize(model.scope)}`) : ''),
      ...body,
    ];
  return card.slice(0, MAX_LINES).map(line => cell(line, outer));
};

export const statusModel = (input: Readonly<{
  scope: string;
  stats: Readonly<{ documents: number; chunks: number; vectors: number; facts: number; events: number; bytes: number }>;
  curation: CurationStats;
  error?: string;
}>): MemoryPanelModel => ({
  title: 'memory · status',
  scope: input.scope,
  kind: 'status',
  metrics: [
    { label: 'facts', value: String(input.stats.facts) },
    { label: 'queued', value: String(input.curation.pending + input.curation.claimed) },
    { label: 'failed', value: String(input.curation.failed) },
    { label: 'store', value: bytes(input.stats.bytes) },
  ],
  rows: [{ id: 'detail', cells: [`docs ${input.stats.documents}`, `blocked ${input.curation.blocked}`] }],
  ...(input.error ? { error: input.error } : {}),
  footer: FOOTER,
});

export const sourcesModel = (input: Readonly<{
  scope: string;
  adapters: readonly (SyncDecision & { last?: SyncRun | null })[];
  error?: string;
}>): MemoryPanelModel => {
  const due = input.adapters.filter(adapter => adapter.due).length;
  const failed = input.adapters.filter(adapter => adapter.last?.ok === false).length;
  return {
    title: 'memory · sources',
    scope: input.scope,
    kind: 'sources',
    metrics: [
      { label: 'adapters', value: String(input.adapters.length) },
      { label: 'due', value: String(due) },
      { label: 'failed', value: String(failed) },
    ],
    rows: [
      { id: 'verdict', cells: [due ? `${due} due for /memory sync` : 'nothing due'] },
      ...input.adapters.map(adapter => ({
        id: adapter.adapter,
        cells: [adapter.adapter, adapter.due ? 'yes' : 'no', adapter.last?.ok === false ? 'fail' : adapter.reason],
      })),
    ],
    ...(input.error ? { error: input.error } : {}),
    footer: FOOTER,
  };
};

export const syncModel = (results: readonly SourceSyncResult[], error?: string): MemoryPanelModel => ({
  title: 'memory · sync',
  scope: results.map(item => item.adapter).join(' ') || 'none',
  kind: 'sync',
  metrics: [
    { label: 'scanned', value: String(total(results, 'discovered')) },
    { label: 'new', value: String(total(results, 'indexed')) },
    { label: 'queued', value: String(total(results, 'queued')) },
  ],
  rows: [
    { id: 'verdict', cells: [syncVerdict(results)] },
    ...results.map(item => ({
      id: item.adapter,
      cells: [
        item.adapter,
        `${item.discovered} seen`,
        item.indexed ? `${item.indexed} new` : `${item.unchanged} same`,
        item.gaps[0] ? 'gap' : item.queued ? `queue ${item.queued}` : 'idle',
      ],
    })),
  ],
  ...(error ? { error } : {}),
  footer: FOOTER,
});

export const resultModel = (title: string, rows: readonly string[], error?: string): MemoryPanelModel => {
  const parsed = rows.map((row, index) => ({ index, row, pair: pair(row) }));
  const tiles = parsed.flatMap(item => item.pair && item.pair.value.length <= 18 && !item.pair.value.includes(' ') ? [item] : []);
  const metrics = tiles.slice(0, 3).map(item => item.pair!);
  const used = new Set(tiles.slice(0, 3).map(item => item.index));
  const rest = parsed.filter(item => !used.has(item.index)).map(item => item.row);
  return {
    title,
    scope: '',
    kind: 'result',
    metrics,
    rows: rest.map((cell, index) => ({ id: index === 0 ? 'verdict' : String(index), cells: [cell] })),
    ...(error ? { error } : {}),
    footer: FOOTER,
  };
};

export const errorModel = (message: string): MemoryPanelModel => ({
  title: 'memory · error',
  scope: '',
  kind: 'error',
  metrics: [{ label: 'status', value: 'error' }],
  rows: [],
  error: message,
  footer: FOOTER,
});

export const memoryPanel = (model: MemoryPanelModel, theme: Theme, done: () => void): Component => ({
  render: width => formatPanel(model, width, theme),
  invalidate() {},
  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
  },
});

export const presentMemoryPanel = async (ctx: MemoryPresenter, model: MemoryPanelModel): Promise<void> => {
  const text = formatPanel(model, 80).join('\n');
  if (ctx.mode === 'tui' && ctx.hasUI && ctx.ui.custom) {
    try {
      await ctx.ui.custom((_tui, theme, _keys, done) => memoryPanel(model, theme, () => done(null)), {
        overlay: true,
        overlayOptions: { minWidth: 52, width: 72, maxHeight: 18, anchor: 'center' },
        onHandle: handle => { handle.focus(); },
      });
      return;
    } catch (error) {
      if (!panelDismissed(error)) throw error;
    }
  }
  ctx.ui.notify(text, model.kind === 'error' ? 'error' : 'info');
};
