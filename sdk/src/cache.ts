export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryStorage implements KeyValueStorage {
  #items = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.#items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.#items.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.#items.delete(key);
  }
}

export type CacheEntry<T> = { value: T; storedAt: number };

// A persistent response cache (AsyncStorage on the device) so screens render instantly and offline.
export class ResponseCache {
  #storage: KeyValueStorage;
  #namespace: string;
  #now: () => number;

  constructor(storage: KeyValueStorage, options: { namespace?: string; now?: () => number } = {}) {
    this.#storage = storage;
    this.#namespace = options.namespace ?? 'pp-cache:v1';
    this.#now = options.now ?? Date.now;
  }

  #key(key: string): string {
    return `${this.#namespace}:${key}`;
  }

  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    const raw = await this.#storage.getItem(this.#key(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as CacheEntry<T>;
    } catch {
      await this.#storage.removeItem(this.#key(key));
      return null;
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    const entry: CacheEntry<T> = { value, storedAt: this.#now() };
    await this.#storage.setItem(this.#key(key), JSON.stringify(entry));
  }

  async remove(key: string): Promise<void> {
    await this.#storage.removeItem(this.#key(key));
  }

  age(entry: CacheEntry<unknown>): number {
    return this.#now() - entry.storedAt;
  }
}

export type CachedState<T> = {
  data: T | undefined;
  source: 'none' | 'cache' | 'network';
  // True while the shown data is older than maxAgeMs or the last refresh failed.
  stale: boolean;
  loading: boolean;
  error: unknown;
  storedAt: number | null;
};

// Stale-while-revalidate: emit cached data immediately, then refresh from the network.
// If the network fails, keep showing the cached data and report the error.
export async function loadWithCache<T>(
  cache: ResponseCache,
  key: string,
  loader: () => Promise<T>,
  onUpdate: (state: CachedState<T>) => void,
  options: { maxAgeMs?: number; force?: boolean } = {},
): Promise<CachedState<T>> {
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  const cached = await cache.read<T>(key);
  let state: CachedState<T> = {
    data: cached?.value,
    source: cached ? 'cache' : 'none',
    stale: cached ? cache.age(cached) > maxAgeMs : false,
    loading: true,
    error: null,
    storedAt: cached?.storedAt ?? null,
  };
  if (cached && !state.stale && !options.force) {
    state = { ...state, loading: false };
    onUpdate(state);
    return state;
  }
  onUpdate(state);
  try {
    const value = await loader();
    await cache.write(key, value);
    state = { data: value, source: 'network', stale: false, loading: false, error: null, storedAt: Date.now() };
  } catch (error) {
    state = { ...state, loading: false, error, stale: state.data !== undefined };
  }
  onUpdate(state);
  return state;
}
