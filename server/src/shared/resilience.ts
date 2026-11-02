import { backoffDelay, sleep } from '../../../sdk/src/retry.ts';
import { HttpError } from './http.ts';
import type { Logger } from './log.ts';
import type { Counter, Histogram, Registry } from './metrics.ts';

export class CircuitOpenError extends Error {
  name = 'CircuitOpenError';
  retryAfterMs: number;

  constructor(name: string, retryAfterMs: number) {
    super(`Circuit for ${name} is open`);
    this.retryAfterMs = retryAfterMs;
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export type BreakerOptions = {
  name: string;
  // Opens when at least minimumCalls of the last windowSize calls ran and the failure rate reaches
  // failureRateThreshold, or immediately after consecutiveFailures failures in a row.
  windowSize?: number;
  minimumCalls?: number;
  failureRateThreshold?: number;
  consecutiveFailures?: number;
  cooldownMs?: number;
  now?: () => number;
  onStateChange?: (state: BreakerState) => void;
};

// A failure-rate circuit breaker over a sliding window of recent calls (in the style of
// resilience4j), with a fast trip for hard outages. While open it fails fast; after the cooldown
// it lets one trial call through and closes again if that call succeeds.
export class CircuitBreaker {
  name: string;
  state: BreakerState = 'closed';
  #outcomes: boolean[] = [];
  #next = 0;
  #failuresInWindow = 0;
  #consecutive = 0;
  #openedAt = 0;
  #trialInFlight = false;
  #windowSize: number;
  #minimumCalls: number;
  #rateThreshold: number;
  #consecutiveThreshold: number;
  #cooldownMs: number;
  #now: () => number;
  #onStateChange: ((state: BreakerState) => void) | undefined;

  constructor(options: BreakerOptions) {
    this.name = options.name;
    this.#windowSize = options.windowSize ?? 100;
    this.#minimumCalls = Math.min(options.minimumCalls ?? 50, this.#windowSize);
    this.#rateThreshold = options.failureRateThreshold ?? 0.5;
    this.#consecutiveThreshold = options.consecutiveFailures ?? 10;
    this.#cooldownMs = options.cooldownMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  async exec<T>(fn: () => Promise<T>, isFailure: (result: T) => boolean = () => false): Promise<T> {
    // Only the call admitted as the half-open trial may decide whether the circuit closes; a slow
    // call that started before the circuit opened must not.
    const isTrial = this.#beforeCall();
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      this.#record(false, isTrial);
      throw error;
    }
    this.#record(!isFailure(result), isTrial);
    return result;
  }

  #beforeCall(): boolean {
    if (this.state === 'open') {
      const elapsed = this.#now() - this.#openedAt;
      if (elapsed < this.#cooldownMs) throw new CircuitOpenError(this.name, this.#cooldownMs - elapsed);
      this.#setState('half_open');
    }
    if (this.state === 'half_open') {
      if (this.#trialInFlight) throw new CircuitOpenError(this.name, this.#cooldownMs);
      this.#trialInFlight = true;
      return true;
    }
    return false;
  }

  #record(success: boolean, isTrial: boolean): void {
    if (this.state === 'half_open') {
      if (!isTrial) return;
      this.#trialInFlight = false;
      if (success) {
        this.#reset();
        this.#setState('closed');
      } else {
        this.#open();
      }
      return;
    }
    if (this.state === 'open') return;
    this.#consecutive = success ? 0 : this.#consecutive + 1;
    if (this.#outcomes.length < this.#windowSize) {
      this.#outcomes.push(!success);
    } else {
      if (this.#outcomes[this.#next]) this.#failuresInWindow--;
      this.#outcomes[this.#next] = !success;
      this.#next = (this.#next + 1) % this.#windowSize;
    }
    if (!success) this.#failuresInWindow++;
    const calls = this.#outcomes.length;
    const rateTripped = calls >= this.#minimumCalls && this.#failuresInWindow / calls >= this.#rateThreshold;
    if (rateTripped || this.#consecutive >= this.#consecutiveThreshold) this.#open();
  }

  #open(): void {
    this.#openedAt = this.#now();
    this.#reset();
    this.#setState('open');
  }

  #reset(): void {
    this.#outcomes = [];
    this.#next = 0;
    this.#failuresInWindow = 0;
    this.#consecutive = 0;
  }

  #setState(state: BreakerState): void {
    if (this.state === state) return;
    this.state = state;
    this.#onStateChange?.(state);
  }
}

export type TakeResult = { ok: boolean; retryAfterSec: number; remaining: number };

// Caches one shared value (such as catalog-wide home sections) for ttlMs. Concurrent misses share
// one load, and if a refresh fails the last value is served for up to maxStaleMs.
export class TtlCache<T> {
  #value: { data: T; loadedAt: number } | null = null;
  #loading: Promise<T> | null = null;
  #ttlMs: number;
  #maxStaleMs: number;
  #now: () => number;

  constructor(options: { ttlMs: number; maxStaleMs?: number; now?: () => number }) {
    this.#ttlMs = options.ttlMs;
    this.#maxStaleMs = options.maxStaleMs ?? 10 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  async get(load: () => Promise<T>): Promise<T> {
    const now = this.#now();
    if (this.#value && now - this.#value.loadedAt < this.#ttlMs) return this.#value.data;
    if (!this.#loading) {
      this.#loading = load()
        .then((data) => {
          this.#value = { data, loadedAt: this.#now() };
          return data;
        })
        .finally(() => {
          this.#loading = null;
        });
    }
    try {
      return await this.#loading;
    } catch (error) {
      if (this.#value && now - this.#value.loadedAt < this.#maxStaleMs) return this.#value.data;
      throw error;
    }
  }
}

// Token bucket rate limiter keyed by client session.
export class TokenBucket {
  #capacity: number;
  #refillPerSec: number;
  #now: () => number;
  #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: { capacity: number; refillPerSec: number; now?: () => number }) {
    this.#capacity = options.capacity;
    this.#refillPerSec = options.refillPerSec;
    this.#now = options.now ?? Date.now;
  }

  take(key: string, cost = 1): TakeResult {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= 10_000) this.#evictIdle(now);
      bucket = { tokens: this.#capacity, updatedAt: now };
      this.#buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.#refillPerSec);
    bucket.updatedAt = now;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, retryAfterSec: 0, remaining: Math.floor(bucket.tokens) };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cost - bucket.tokens) / this.#refillPerSec)), remaining: 0 };
  }

  #evictIdle(now: number): void {
    for (const [key, bucket] of this.#buckets) if (now - bucket.updatedAt > 300_000) this.#buckets.delete(key);
  }
}

export type UpstreamOptions = {
  name: string;
  baseUrl: string;
  internalToken: string;
  registry: Registry;
  logger: Logger;
  timeoutMs?: number;
  getRetries?: number;
  breaker?: Omit<BreakerOptions, 'name' | 'onStateChange'>;
};

export type UpstreamCall = {
  userId?: string;
  requestId?: string;
  body?: unknown;
  query?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
};

export type UpstreamResponse<T = unknown> = { status: number; body: T; headers: Headers };

function toUpstreamError(name: string, error: unknown): HttpError {
  if (error instanceof CircuitOpenError) {
    return new HttpError(503, 'upstream_unavailable', `${name} is temporarily unavailable`, undefined, {
      'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
    });
  }
  if ((error as Error)?.name === 'TimeoutError') return new HttpError(504, 'upstream_timeout', `${name} did not respond in time`);
  return new HttpError(503, 'upstream_unavailable', `${name} is unreachable`, undefined, { 'retry-after': '1' });
}

// Service-to-service HTTP client: timeouts, a circuit breaker per upstream, and retries for GETs only.
// Writes are not retried here; the mobile client retries them with an idempotency key, so retries
// happen at one layer and do not multiply.
export class Upstream {
  name: string;
  breaker: CircuitBreaker;
  #baseUrl: string;
  #token: string;
  #timeoutMs: number;
  #getRetries: number;
  #requests: Counter;
  #latency: Histogram;

  constructor(options: UpstreamOptions) {
    this.name = options.name;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.internalToken;
    this.#timeoutMs = options.timeoutMs ?? 3_000;
    this.#getRetries = options.getRetries ?? 1;
    this.#requests = options.registry.counter('upstream_requests_total', 'Calls to other services by outcome');
    this.#latency = options.registry.histogram('upstream_request_duration_seconds', 'Latency of calls to other services');
    const stateGauge = options.registry.gauge('circuit_breaker_state', 'Circuit state per upstream: 0 closed, 0.5 half-open, 1 open');
    stateGauge.set({ upstream: this.name }, 0);
    this.breaker = new CircuitBreaker({
      ...options.breaker,
      name: this.name,
      onStateChange: (state) => {
        stateGauge.set({ upstream: this.name }, state === 'open' ? 1 : state === 'half_open' ? 0.5 : 0);
        options.logger.warn('circuit_state_changed', { upstream: this.name, state });
      },
    });
  }

  async request<T = unknown>(method: string, path: string, call: UpstreamCall = {}): Promise<UpstreamResponse<T>> {
    const query = call.query ? (call.query.startsWith('?') ? call.query : `?${call.query}`) : '';
    const url = `${this.#baseUrl}${path}${query}`;
    const headers: Record<string, string> = { accept: 'application/json', 'x-internal-token': this.#token };
    if (call.userId) headers['x-user-id'] = call.userId;
    if (call.requestId) headers['x-request-id'] = call.requestId;
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
    let body: string | undefined;
    if (call.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(call.body);
    }
    const attempts = method === 'GET' ? this.#getRetries + 1 : 1;
    const timeoutMs = call.timeoutMs ?? this.#timeoutMs;

    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      let outcome = 'ok';
      try {
        const response = await this.breaker.exec(
          async () => {
            const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
            const text = await res.text();
            const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
            const parsed: unknown = text === '' ? undefined : isJson ? JSON.parse(text) : text;
            return { status: res.status, body: parsed as T, headers: res.headers };
          },
          (r) => r.status >= 500,
        );
        outcome = response.status >= 500 ? 'server_error' : response.status >= 400 ? 'client_error' : 'ok';
        if (response.status >= 502 && attempt < attempts) {
          await sleep(backoffDelay(attempt - 1, 50, 500));
          continue;
        }
        return response;
      } catch (error) {
        outcome = error instanceof CircuitOpenError ? 'circuit_open' : (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'network_error';
        if (!(error instanceof CircuitOpenError) && attempt < attempts) {
          await sleep(backoffDelay(attempt - 1, 50, 500));
          continue;
        }
        throw toUpstreamError(this.name, error);
      } finally {
        this.#requests.inc({ upstream: this.name, method, outcome });
        this.#latency.observe({ upstream: this.name, method }, (performance.now() - started) / 1000);
      }
    }
  }

  // Like request(), but turns error responses into HttpErrors that keep the upstream code and message.
  async json<T>(method: string, path: string, call: UpstreamCall = {}): Promise<T> {
    const res = await this.request<T>(method, path, call);
    if (res.status >= 400) {
      const err = (res.body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      const headers: Record<string, string> = {};
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) headers['retry-after'] = retryAfter;
      throw new HttpError(res.status, err?.code ?? 'upstream_error', err?.message ?? `${this.name} returned ${res.status}`, err?.details, headers);
    }
    return res.body;
  }
}
