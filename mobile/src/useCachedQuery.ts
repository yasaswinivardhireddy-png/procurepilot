import { loadWithCache, type CachedState } from '@procurepilot/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from './session';

const INITIAL: CachedState<never> = { data: undefined, source: 'none', stale: false, loading: true, error: null, storedAt: null };

export type Query<T> = CachedState<T> & { refresh(): Promise<void>; mutate(value: T): Promise<void> };

// Stale-while-revalidate data loading: renders saved data instantly (and offline), then refreshes.
// Use persist: false for data that should not be stored on the device, such as search results.
export function useCachedQuery<T>(key: string | null, loader: () => Promise<T>, options: { maxAgeMs?: number; persist?: boolean } = {}): Query<T> {
  const { cache } = useSession();
  const [state, setState] = useState<CachedState<T>>(INITIAL);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const generation = useRef(0);
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  const persist = options.persist ?? true;

  const load = useCallback(
    async (force: boolean) => {
      if (!key) return;
      const run = ++generation.current;
      const update = (next: CachedState<T>) => {
        if (run === generation.current) setState(next);
      };
      if (!persist) {
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
          update({ data: await loaderRef.current(), source: 'network', stale: false, loading: false, error: null, storedAt: Date.now() });
        } catch (error) {
          if (run === generation.current) setState((s) => ({ ...s, loading: false, error }));
        }
        return;
      }
      await loadWithCache(cache, key, () => loaderRef.current(), update, { maxAgeMs, force });
    },
    [cache, key, maxAgeMs, persist],
  );

  useEffect(() => {
    void load(false);
    return () => {
      generation.current++;
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  const mutate = useCallback(
    async (value: T) => {
      generation.current++;
      setState((s) => ({ ...s, data: value, source: 'network', stale: false, loading: false, error: null, storedAt: Date.now() }));
      if (key && persist) await cache.write(key, value);
    },
    [cache, key, persist],
  );

  return { ...state, refresh, mutate };
}
