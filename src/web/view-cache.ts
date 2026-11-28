import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

type Entry = { data?: unknown; time: number; pending?: Promise<unknown> };
export class ViewCache {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  peek<T>(key: string): T | undefined {
    return this.entries.get(key)?.data as T | undefined;
  }
  subscribe(key: string, notify: () => void) {
    const listeners = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, listeners);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
  private notify(key: string) {
    this.listeners.get(key)?.forEach((fn) => fn());
  }
  put(key: string, data: unknown) {
    this.entries.delete(key);
    this.entries.set(key, { data, time: Date.now() });
    if (this.entries.size > 64) {
      for (const [old, entry] of this.entries) {
        if (!entry.pending && !this.listeners.has(old)) {
          this.entries.delete(old);
          break;
        }
      }
    }
    this.notify(key);
  }
  invalidate(key: string, forget = false) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (forget || entry.data === undefined) this.entries.delete(key);
    else this.entries.set(key, { data: entry.data, time: Number.NEGATIVE_INFINITY });
    this.notify(key);
  }
  expire(prefix: string, forget = false) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.invalidate(key, forget);
    }
  }
  read<T>(key: string, load: () => Promise<T>, freshFor: number): Promise<T> {
    const old = this.entries.get(key);
    if (old?.pending) return old.pending as Promise<T>;
    if (old && old.data !== undefined && Date.now() - old.time < freshFor)
      return Promise.resolve(old.data as T);
    const entry: Entry = { data: old?.data, time: old?.time ?? 0 };
    this.entries.set(key, entry);
    const pending = Promise.resolve()
      .then(load)
      .then((data) => {
        if (this.entries.get(key) === entry) this.put(key, data);
        return data;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) {
          if (entry.data === undefined || [401, 403, 404, 410].includes(error.status))
            this.entries.delete(key);
          else entry.pending = undefined;
          this.notify(key);
        }
        throw error;
      });
    entry.pending = pending;
    return pending;
  }
  json<T>(url: string, freshFor: number): Promise<T> {
    return this.read(
      url,
      async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw Object.assign(new Error(body.message || '暂时无法更新'), { status: response.status });
        }
        return response.json();
      },
      freshFor
    );
  }
}

export const ViewCacheContext = createContext<ViewCache>(null!);
export const useViewCache = () => useContext(ViewCacheContext);

// Each caller only subscribes to its current resource. Outstanding reads settle in their original session.
export function useViewData<T>(url: string, freshFor: number, enabled = true) {
  const cache = useViewCache();
  const subscribe = useCallback((fn: () => void) => cache.subscribe(url, fn), [cache, url]);
  const data = useSyncExternalStore(subscribe, () => (enabled ? cache.peek<T>(url) : undefined));
  const read = useCallback(
    (refresh = false) => {
      if (!enabled) return Promise.resolve(undefined);
      if (refresh) cache.invalidate(url);
      return cache.json<T>(url, freshFor);
    },
    [cache, url, freshFor, enabled]
  );
  return { data, read };
}
