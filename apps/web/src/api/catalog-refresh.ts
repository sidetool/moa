interface RefreshState { refreshing?: boolean; pages?: { refreshing?: boolean }[] }
interface ObservedQuery { state: { data?: unknown; status: string; dataUpdateCount: number }; getObserversCount(): number }
const refreshWindows = new WeakMap<ObservedQuery, { start: number; count: number }>();

/** Only visible queries with shared server work in flight need a follow-up read. */
export function catalogRefetchInterval(query: ObservedQuery): number | false {
  const data = query.state.data as RefreshState | undefined;
  if (query.state.status !== 'success' || !(data?.refreshing || data?.pages?.some(page=>page.refreshing))) {
    refreshWindows.delete(query);
    return false;
  }
  let window = refreshWindows.get(query);
  if (!window || !query.getObserversCount()) {
    window = { start: Date.now(), count: query.state.dataUpdateCount };
    refreshWindows.set(query,window);
  }
  if (Date.now()-window.start >= 90_000) return false;
  return Math.min(8_000, 1000 * 2 ** Math.min(3, query.state.dataUpdateCount-window.count));
}

export const catalogReadOptions = { refetchOnMount: 'always', refetchInterval:catalogRefetchInterval } as const;
