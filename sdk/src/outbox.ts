import type { KeyValueStorage } from './cache.ts';
import { isPermanentError } from './errors.ts';
import { newIdempotencyKey, randomId } from './random.ts';
import { backoffDelay } from './retry.ts';

export type OutboxStatus = 'pending' | 'sending' | 'failed';

export type OutboxEntry<P = unknown> = {
  id: string;
  kind: string;
  payload: P;
  idempotencyKey: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: OutboxStatus;
  lastError: string | null;
};

export type OutboxExecutor = (entry: OutboxEntry) => Promise<unknown>;

export type OutboxEvent =
  | { type: 'sent'; entry: OutboxEntry; result: unknown }
  | { type: 'failed'; entry: OutboxEntry; error: unknown }
  | { type: 'changed'; entries: OutboxEntry[] };

export type OutboxOptions = {
  storageKey?: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  random?: () => number;
  isPermanentError?: (error: unknown) => boolean;
};

export type FlushResult = { sent: number; pending: number; failed: number };

// A durable queue for mutations such as checkout. Each entry is written to storage with its
// idempotency key BEFORE the first attempt, so replays after a crash, timeout or lost response
// reuse the key and the server returns the original result instead of creating a duplicate.
export class Outbox {
  #storage: KeyValueStorage;
  #executor: OutboxExecutor;
  #entries: OutboxEntry[] = [];
  #listeners = new Set<(event: OutboxEvent) => void>();
  #flushing: Promise<FlushResult> | null = null;
  // Storage writes are chained so they land in order; each write stores the latest state.
  #writes: Promise<void> = Promise.resolve();
  #storageKey: string;
  #baseDelayMs: number;
  #maxDelayMs: number;
  #now: () => number;
  #random: () => number;
  #isPermanent: (error: unknown) => boolean;

  constructor(storage: KeyValueStorage, executor: OutboxExecutor, options: OutboxOptions = {}) {
    this.#storage = storage;
    this.#executor = executor;
    this.#storageKey = options.storageKey ?? 'pp-outbox:v1';
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#isPermanent = options.isPermanentError ?? isPermanentError;
  }

  async load(): Promise<OutboxEntry[]> {
    const raw = await this.#storage.getItem(this.#storageKey);
    const parsed = raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
    // An entry left in "sending" means the app stopped mid-request. Its outcome is unknown,
    // so it goes back to pending and is replayed with the same idempotency key.
    this.#entries = parsed.map((e) => (e.status === 'sending' ? { ...e, status: 'pending' } : e));
    this.#emit({ type: 'changed', entries: this.entries() });
    return this.entries();
  }

  entries(): OutboxEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  subscribe(listener: (event: OutboxEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async enqueue<P>(kind: string, payload: P, options: { idempotencyKey?: string } = {}): Promise<OutboxEntry<P>> {
    const entry: OutboxEntry<P> = {
      id: randomId('obx', 8),
      kind,
      payload,
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
      createdAt: this.#now(),
      attempts: 0,
      nextAttemptAt: 0,
      status: 'pending',
      lastError: null,
    };
    this.#entries.push(entry);
    try {
      await this.#persist();
    } catch (error) {
      // Never send what could not be saved: the durability guarantee comes first.
      this.#entries = this.#entries.filter((e) => e.id !== entry.id);
      this.#emit({ type: 'changed', entries: this.entries() });
      throw error;
    }
    return { ...entry };
  }

  async discard(id: string): Promise<void> {
    this.#entries = this.#entries.filter((e) => e.id !== id);
    await this.#persist();
  }

  async retry(id: string): Promise<void> {
    this.#entries = this.#entries.map((e) => (e.id === id ? { ...e, status: 'pending', nextAttemptAt: 0, lastError: null } : e));
    await this.#persist();
  }

  // Single-flight: concurrent callers share one flush, so an entry is never sent twice at once.
  flush(): Promise<FlushResult> {
    if (!this.#flushing) {
      this.#flushing = this.#flushOnce().finally(() => {
        this.#flushing = null;
      });
    }
    return this.#flushing;
  }

  async #flushOnce(): Promise<FlushResult> {
    let sent = 0;
    const due = this.#entries.filter((e) => e.status === 'pending' && e.nextAttemptAt <= this.#now()).map((e) => e.id);
    for (const id of due) {
      const current = this.#entries.find((e) => e.id === id);
      if (!current || current.status !== 'pending') continue;
      this.#update(id, { status: 'sending', attempts: current.attempts + 1 });
      try {
        await this.#persist();
      } catch {
        // Storage is failing: put the entry back and try again on a later flush.
        this.#update(id, { status: 'pending', attempts: current.attempts });
        break;
      }
      const entry = this.#entries.find((e) => e.id === id)!;
      try {
        const result = await this.#executor({ ...entry });
        this.#entries = this.#entries.filter((e) => e.id !== id);
        sent++;
        this.#emit({ type: 'sent', entry: { ...entry }, result });
        await this.#persist().catch(() => {});
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        if (this.#isPermanent(error)) {
          this.#update(id, { status: 'failed', lastError: message });
          this.#emit({ type: 'failed', entry: { ...this.#entries.find((e) => e.id === id)! }, error });
        } else {
          // Wait at least as long as the server asked (for example while a circuit is open).
          const retryAfterMs = (error as { retryAfterMs?: number | null } | null)?.retryAfterMs ?? 0;
          const delay = Math.max(backoffDelay(entry.attempts - 1, this.#baseDelayMs, this.#maxDelayMs, this.#random), retryAfterMs);
          this.#update(id, { status: 'pending', lastError: message, nextAttemptAt: this.#now() + delay });
        }
        await this.#persist().catch(() => {});
      }
    }
    return {
      sent,
      pending: this.#entries.filter((e) => e.status === 'pending').length,
      failed: this.#entries.filter((e) => e.status === 'failed').length,
    };
  }

  #update(id: string, patch: Partial<OutboxEntry>): void {
    this.#entries = this.#entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
  }

  #persist(): Promise<void> {
    const write = this.#writes.then(() => this.#storage.setItem(this.#storageKey, JSON.stringify(this.#entries)));
    this.#writes = write.catch(() => {});
    this.#emit({ type: 'changed', entries: this.entries() });
    return write;
  }

  #emit(event: OutboxEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
