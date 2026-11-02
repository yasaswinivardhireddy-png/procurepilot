import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { backoffDelay, parseRetryAfter } from '../sdk/src/retry.ts';
import { HttpError } from '../server/src/shared/http.ts';
import { createLogger } from '../server/src/shared/log.ts';
import { Registry } from '../server/src/shared/metrics.ts';
import { CircuitBreaker, CircuitOpenError, TokenBucket, TtlCache, Upstream } from '../server/src/shared/resilience.ts';

const boom = async () => {
  throw new Error('boom');
};

describe('circuit breaker', () => {
  it('opens after a run of consecutive failures, fails fast, then recovers through one trial call', async () => {
    let now = 0;
    const states: string[] = [];
    const breaker = new CircuitBreaker({ name: 'orders', consecutiveFailures: 3, cooldownMs: 1_000, now: () => now, onStateChange: (s) => states.push(s) });
    for (let i = 0; i < 3; i++) await assert.rejects(breaker.exec(boom), /boom/);
    assert.equal(breaker.state, 'open');
    let called = false;
    await assert.rejects(
      breaker.exec(async () => {
        called = true;
      }),
      CircuitOpenError,
    );
    assert.equal(called, false, 'an open circuit must not call the upstream');
    now = 1_000;
    assert.equal(await breaker.exec(async () => 'ok'), 'ok');
    assert.deepEqual(states, ['open', 'half_open', 'closed']);
  });

  it('opens on the failure rate over the sliding window, even with interleaved successes', async () => {
    const breaker = new CircuitBreaker({ name: 'x', windowSize: 10, minimumCalls: 6, failureRateThreshold: 0.5, consecutiveFailures: 100 });
    const call = (status: number) => breaker.exec(async () => ({ status }), (r) => r.status >= 500);
    for (const status of [503, 200, 503, 200, 200]) await call(status);
    assert.equal(breaker.state, 'closed', 'too few calls to judge');
    await call(503);
    assert.equal(breaker.state, 'open', '3 of 6 calls failed');
  });

  it('stays closed under a moderate error rate', async () => {
    const breaker = new CircuitBreaker({ name: 'x', windowSize: 20, minimumCalls: 10, failureRateThreshold: 0.5, consecutiveFailures: 5 });
    for (let i = 0; i < 300; i++) await breaker.exec(async () => ({ status: i % 3 === 0 ? 503 : 200 }), (r) => r.status >= 500);
    assert.equal(breaker.state, 'closed');
  });

  it('re-opens when the trial fails and allows only one trial at a time', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ name: 'x', consecutiveFailures: 1, cooldownMs: 100, now: () => now });
    await assert.rejects(breaker.exec(boom));
    now = 100;
    let release!: () => void;
    const trial = breaker.exec(() => new Promise<void>((resolve) => (release = resolve)));
    await assert.rejects(breaker.exec(async () => 'second'), CircuitOpenError);
    release();
    await trial;
    assert.equal(breaker.state, 'closed');
    await assert.rejects(breaker.exec(boom));
    now = 200;
    await assert.rejects(breaker.exec(boom), /boom/);
    assert.equal(breaker.state, 'open');
  });

  it('lets only the trial call decide the half-open state', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ name: 'x', consecutiveFailures: 1, cooldownMs: 100, now: () => now });
    let releaseSlow!: () => void;
    const slow = breaker.exec(() => new Promise<void>((resolve) => (releaseSlow = resolve)));
    await assert.rejects(breaker.exec(boom));
    now = 100;
    let releaseTrial!: () => void;
    const trial = breaker.exec(() => new Promise<void>((resolve) => (releaseTrial = resolve)));
    releaseSlow();
    await slow;
    assert.equal(breaker.state, 'half_open', 'a call from before the circuit opened must not close it');
    await assert.rejects(breaker.exec(async () => 'x'), CircuitOpenError);
    releaseTrial();
    await trial;
    assert.equal(breaker.state, 'closed');
  });
});

describe('token bucket', () => {
  it('allows a burst, rejects with Retry-After, then refills', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => now });
    for (let i = 0; i < 3; i++) assert.equal(bucket.take('a').ok, true);
    assert.deepEqual(bucket.take('a'), { ok: false, retryAfterSec: 1, remaining: 0 });
    assert.equal(bucket.take('b').ok, true, 'keys are independent');
    now = 1_000;
    assert.equal(bucket.take('a').ok, true);
  });
});

describe('TTL cache', () => {
  it('shares one load, expires after the TTL and serves stale data when a refresh fails', async () => {
    let now = 0;
    let loads = 0;
    let failing = false;
    const cache = new TtlCache<number>({ ttlMs: 100, maxStaleMs: 1_000, now: () => now });
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      if (failing) throw new Error('catalog down');
      return loads;
    };
    assert.deepEqual(await Promise.all([cache.get(load), cache.get(load)]), [1, 1]);
    now = 50;
    assert.equal(await cache.get(load), 1);
    now = 150;
    assert.equal(await cache.get(load), 2);
    now = 300;
    failing = true;
    assert.equal(await cache.get(load), 2, 'serves the last value while the refresh fails');
    now = 2_000;
    await assert.rejects(cache.get(load), /catalog down/);
  });
});

describe('backoff and Retry-After', () => {
  it('uses capped exponential backoff with full jitter', () => {
    assert.equal(backoffDelay(0, 100, 5_000, () => 1), 100);
    assert.equal(backoffDelay(3, 100, 5_000, () => 1), 800);
    assert.equal(backoffDelay(10, 100, 5_000, () => 1), 5_000);
    assert.equal(backoffDelay(3, 100, 5_000, () => 0), 0);
  });

  it('parses seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('2'), 2_000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.equal(parseRetryAfter('soon'), null);
    assert.equal(parseRetryAfter(null), null);
  });
});

describe('upstream client', () => {
  it('maps an unreachable service to 503 and then fails fast with an open circuit', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const upstream = new Upstream({
      name: 'orders',
      baseUrl: `http://127.0.0.1:${port}`,
      internalToken: 't',
      registry: new Registry(),
      logger: createLogger('test', 'silent'),
      breaker: { consecutiveFailures: 2, cooldownMs: 60_000 },
    });
    await assert.rejects(upstream.request('GET', '/v1/cart'), (e: unknown) => e instanceof HttpError && e.status === 503);
    await assert.rejects(
      upstream.request('GET', '/v1/cart'),
      (e: unknown) => e instanceof HttpError && e.code === 'upstream_unavailable' && Number(e.headers['retry-after']) > 0,
    );
    assert.equal(upstream.breaker.state, 'open');
  });
});
