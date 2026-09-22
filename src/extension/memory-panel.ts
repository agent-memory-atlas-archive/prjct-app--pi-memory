import { SYMBOL, ago, type PanelAction, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { CurationStats } from '../curation/types.ts';
import type { SyncDecision } from '../sources/schedule.ts';
import type { SyncRun } from '../storage/projection.ts';

/** Everything /memory shows, loaded in one pass so list and detail agree. */
export type MemorySnapshot = Readonly<{
  initialized: boolean;
  ready: boolean;
  legacy?: boolean;
  project?: string;
  scope?: string;
  stats?: Readonly<{ documents: number; chunks: number; vectors: number; facts: number; events: number; bytes: number }>;
  curation?: CurationStats;
  sources: readonly (SyncDecision & { last?: SyncRun | null })[];
  error?: string;
  /** Memory blocks in this session's context, from pi-context-prune. */
  context?: string;
}>;

/** What the panel can ask the extension to do. Each returns a one-line result. */
export type MemoryOps = Readonly<{
  load(): Promise<MemorySnapshot>;
  init(): Promise<string>;
  sync(adapter?: string): Promise<string>;
  gc(): Promise<string>;
  checkpointWal(): Promise<string>;
  rebuild(): Promise<string>;
  /** Remove superseded memory from this session's context on the next request. */
  prune?(): Promise<string>;
}>;

const STORE = 'store';
const SETUP = 'setup';
const SOURCE = 'source:';
const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
const bytes = (value: number): string => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)}MiB`
  : value >= 1024 ? `${Math.round(value / 1024)}KiB` : `${value}B`;
const when = (iso: string | undefined): number | undefined => {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

type Trace = Readonly<{ at: number; text: string }>;

/** The /memory panel: the store and each source, with one-key maintenance. */
export function memoryPanelSpec(ops: MemoryOps, initial: MemorySnapshot): PanelSpec {
  const state = { snapshot: initial, traces: new Map<string, readonly Trace[]>() };
  const listeners = new Set<() => void>();
  const reload = async (): Promise<void> => {
    state.snapshot = await ops.load();
    for (const listener of listeners) listener();
  };
  const trace = (id: string, text: string): void => {
    state.traces.set(id, [{ at: Date.now(), text }, ...state.traces.get(id) ?? []].slice(0, 20));
  };
  const source = (item: PanelItem | undefined) => item?.id.startsWith(SOURCE)
    ? state.snapshot.sources.find(entry => entry.adapter === item.id.slice(SOURCE.length)) : undefined;
  const act = (id: string | undefined, work: () => Promise<string>) => async (_item: PanelItem | undefined, panel: Parameters<PanelAction['run']>[1]): Promise<void> => {
    const text = clean(await work());
    trace(id ?? STORE, text);
    await reload();
    panel.notice(text, 'success');
  };
  const onStore = (item: PanelItem | undefined): boolean => item?.id === STORE;
  const actions: PanelAction[] = [
    { key: 'i', label: 'Initialize', when: item => item?.id === SETUP, run: act(STORE, ops.init) },
    {
      key: 's', label: item => source(item) ? 'Sync this source' : 'Sync all sources',
      when: item => onStore(item) || !!source(item),
      run: async (item, panel) => act(item?.id, () => ops.sync(source(item)?.adapter))(item, panel),
    },
    { key: 'g', label: 'Collect garbage', when: onStore, run: act(STORE, ops.gc) },
    { key: 'w', label: 'Checkpoint WAL', when: onStore, run: act(STORE, ops.checkpointWal) },
    { key: 'R', label: 'Rebuild index', when: onStore, confirm: true, run: act(STORE, ops.rebuild) },
    ...(ops.prune ? [{ key: 'p', label: 'Prune memory from context', when: onStore, run: act(STORE, ops.prune) }] : []),
  ];

  const items = (): PanelItem[] => {
    const snap = state.snapshot;
    if (!snap.initialized || !snap.ready) {
      return [{ id: SETUP, label: snap.initialized ? 'memory needs repair' : 'memory not initialized', symbol: SYMBOL.attention, tone: 'warning', meta: 'press i' }];
    }
    const queued = (snap.curation?.pending ?? 0) + (snap.curation?.claimed ?? 0);
    return [
      {
        id: STORE, label: 'store',
        symbol: snap.error ? SYMBOL.error : SYMBOL.active, tone: snap.error ? 'error' : 'success',
        meta: `${snap.stats?.facts ?? 0} facts${queued ? ` · ${queued} queued` : ''} · ${bytes(snap.stats?.bytes ?? 0)}`,
      },
      ...snap.sources.map((entry): PanelItem => {
        const failed = entry.last?.ok === false;
        const [symbol, tone]: [string, Tone] = failed ? [SYMBOL.error, 'error'] : entry.due ? [SYMBOL.idle, 'accent'] : [SYMBOL.ok, 'success'];
        return {
          id: `${SOURCE}${entry.adapter}`, label: clean(entry.adapter), symbol, tone,
          meta: failed ? 'sync failed' : entry.due ? 'due' : entry.last ? `synced ${ago(when(entry.last.lastAt))}` : 'never synced',
          search: clean(entry.reason),
        };
      }),
    ];
  };

  const history = (id: string) => ({ title: 'History', lines: (state.traces.get(id) ?? []).map(entry => `${ago(entry.at)}  ${entry.text}`) });

  return {
    title: 'Memory',
    summary: () => {
      const snap = state.snapshot;
      if (!snap.initialized) return 'not initialized';
      const due = snap.sources.filter(entry => entry.due).length;
      return `${clean(snap.scope ?? '')} · ${snap.sources.length} source${snap.sources.length === 1 ? '' : 's'}${due ? ` · ${due} due` : ''}`;
    },
    items,
    detail: item => {
      const snap = state.snapshot;
      if (item.id === SETUP) {
        return {
          title: item.label,
          subtitle: snap.initialized ? 'The database is missing. Initialize again to repair it.' : 'Nothing is stored for this project yet.',
          subtitleTone: 'warning',
          fields: [
            ...(snap.project ? [{ label: 'project', value: clean(snap.project) }] : []),
            { label: 'legacy', value: snap.legacy ? 'available to migrate' : 'none' },
          ],
          sections: [history(STORE)],
        };
      }
      const entry = source(item);
      if (entry) {
        const last = entry.last;
        return {
          title: clean(entry.adapter),
          subtitle: last?.ok === false ? 'Last sync failed.' : entry.due ? 'Due for a sync.' : 'Up to date.',
          subtitleTone: last?.ok === false ? 'error' : entry.due ? 'accent' : 'success',
          fields: [
            { label: 'due', value: entry.due ? 'yes' : 'no' },
            { label: 'why', value: clean(entry.reason) },
            { label: 'last sync', value: last ? `${ago(when(last.lastAt))} · ${last.ok ? 'ok' : 'failed'}` : 'never' },
            ...(last ? [{ label: 'seen', value: String(last.discovered) }, { label: 'indexed', value: String(last.indexed) }] : []),
            ...(last?.detail ? [{ label: 'detail', value: clean(last.detail), tone: (last.ok ? undefined : 'error') as Tone | undefined }] : []),
          ],
          sections: [history(item.id)],
        };
      }
      const stats = snap.stats;
      const curation = snap.curation;
      return {
        title: 'store',
        subtitle: snap.error ? `Last error: ${clean(snap.error)}` : 'Healthy.',
        subtitleTone: snap.error ? 'error' : 'success',
        fields: [
          { label: 'scope', value: clean(snap.scope ?? '') },
          { label: 'facts', value: String(stats?.facts ?? 0) },
          { label: 'documents', value: String(stats?.documents ?? 0) },
          { label: 'chunks', value: `${stats?.chunks ?? 0} · ${stats?.vectors ?? 0} vectors` },
          { label: 'events', value: String(stats?.events ?? 0) },
          { label: 'size', value: bytes(stats?.bytes ?? 0) },
          { label: 'curation', value: `${(curation?.pending ?? 0) + (curation?.claimed ?? 0)} queued · ${curation?.published ?? 0} published` },
          { label: 'problems', value: `${curation?.failed ?? 0} failed · ${curation?.blocked ?? 0} blocked`, tone: (curation?.failed || curation?.blocked) ? 'warning' : undefined },
          { label: 'cache', value: 'session-references-v2' },
          ...(snap.context ? [{ label: 'context', value: clean(snap.context) }] : []),
        ],
        sections: [history(STORE)],
      };
    },
    actions,
    empty: 'Nothing to show. Run /memory init.',
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshMs: 30_000,
  };
}
