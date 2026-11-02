import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, MemoryStorage, NetworkError, Outbox, ResponseCache, TimeoutError, createClient, formatInr, loadWithCache, type CachedState, type FetchLike, type KeyValueStorage } from '../sdk/src/index.ts';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(replies: Reply[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const reply = replies.shift();
    if (!reply) throw new Error('no more replies');
    if (reply instanceof Error) throw reply;
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: reply.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
    };
  };
  return { fetch, calls };
}

const noSleep = async () => {};

describe('SDK client', () => {
  it('retries GETs on 503 with the same request id and honors Retry-After', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakeFetch([
      { status: 503, body: { error: { code: 'busy', message: 'busy' } }, headers: { 'Retry-After': '2' } },
      { status: 200, body: { items: [], total: 0 } },
    ]);
    const client = createClient({ baseUrl: 'http://api', fetch, sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual(await client.listOrders(), { items: [], total: 0 });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2_000]);
    assert.equal(calls[0]!.headers['x-request-id'], calls[1]!.headers['x-request-id']);
  });

  it('waits as long as Retry-After asks, even beyond the normal backoff cap', async () => {
    const sleeps: number[] = [];
    const { fetch } = fakeFetch([
      { status: 503, body: { error: { code: 'upstream_unavailable', message: 'open circuit' } }, headers: { 'retry-after': '5' } },
      { status: 200, body: { lines: [] } },
    ]);
    const client = createClient({ baseUrl: 'http://api', fetch, retry: { maxDelayMs: 50 }, sleep: async (ms) => void sleeps.push(ms) });
    await client.getCart();
    assert.deepEqual(sleeps, [5_000]);
  });

  it('reuses the idempotency key on every retry of a checkout', async () => {
    const { fetch, calls } = fakeFetch([new Error('socket hang up'), { status: 502 }, { status: 201, body: { id: 'ord_1' } }]);
    const client = createClient({ baseUrl: 'http://api', fetch, sleep: noSleep, token: 'tok' });
    const order = await client.checkout({ costCenterId: 'cc_mkt' }, { idempotencyKey: 'idem_checkout_1' });
    assert.equal(order.id, 'ord_1');
    assert.deepEqual(
      calls.map((c) => c.headers['idempotency-key']),
      ['idem_checkout_1', 'idem_checkout_1', 'idem_checkout_1'],
    );
    assert.equal(calls[0]!.headers.authorization, 'Bearer tok');
  });

  it('never retries a POST that has no idempotency key', async () => {
    const { fetch, calls } = fakeFetch([{ status: 503, body: { error: { code: 'busy', message: 'busy' } } }]);
    const client = createClient({ baseUrl: 'http://api', fetch, sleep: noSleep });
    await assert.rejects(client.askAssistant('hi'), (e: unknown) => e instanceof ApiError && e.status === 503);
    assert.equal(calls.length, 1);
  });

  it('surfaces typed errors with the server code and request id', async () => {
    const { fetch } = fakeFetch([{ status: 409, body: { error: { code: 'cart_changed', message: 'Cart changed' } }, headers: { 'x-request-id': 'srv-1' } }]);
    const client = createClient({ baseUrl: 'http://api', fetch, sleep: noSleep });
    await assert.rejects(client.getCart(), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.deepEqual([e.status, e.code, e.requestId, e.retryable], [409, 'cart_changed', 'srv-1', false]);
      return true;
    });
  });

  it('turns slow responses into TimeoutError and network failures into NetworkError', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const slow = createClient({ baseUrl: 'http://api', fetch: hanging, timeoutMs: 20, retry: { retries: 0 } });
    await assert.rejects(slow.getCart(), TimeoutError);
    const { fetch } = fakeFetch([new Error('ECONNREFUSED'), new Error('ECONNREFUSED')]);
    const offline = createClient({ baseUrl: 'http://api', fetch, sleep: noSleep, retry: { retries: 1 } });
    await assert.rejects(offline.getCart(), NetworkError);
  });

  it('encodes query parameters and sends SDUI capabilities', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { items: [], total: 0, nextCursor: null } },
      { status: 200, body: { sections: [] } },
    ]);
    const client = createClient({ baseUrl: 'http://api/', fetch, sduiCapabilities: ['greeting@1', 'banner@1'] });
    await client.searchProducts({ q: 'a4 paper', gstInvoice: true, maxUnitPrice: 30_000 });
    await client.home();
    assert.equal(calls[0]!.url, 'http://api/v1/products?q=a4%20paper&gstInvoice=true&maxUnitPrice=30000');
    assert.equal(calls[1]!.headers['x-sdui-capabilities'], 'greeting@1,banner@1');
  });

  it('formats rupees with Indian digit grouping', () => {
    assert.equal(formatInr(29_900), '₹299.00');
    assert.equal(formatInr(12_345_678), '₹1,23,456.78');
  });

  it('calls the global fetch with the global object as this, as browsers require', async () => {
    const original = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = async function (this: unknown) {
      receiver = this;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    } as typeof fetch;
    try {
      await createClient({ baseUrl: 'http://api' }).listDemoUsers();
      assert.ok(receiver === undefined || receiver === globalThis, 'fetch must not be called as a method of the client');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('offline cache (stale-while-revalidate)', () => {
  const run = async (cache: ResponseCache, loader: () => Promise<string>, options = {}) => {
    const states: CachedState<string>[] = [];
    await loadWithCache(cache, 'home', loader, (s) => states.push(s), options);
    return states;
  };

  it('loads from the network when nothing is cached', async () => {
    const states = await run(new ResponseCache(new MemoryStorage()), async () => 'fresh');
    assert.deepEqual(
      states.map((s) => [s.source, s.loading, s.data]),
      [
        ['none', true, undefined],
        ['network', false, 'fresh'],
      ],
    );
  });

  it('serves fresh cache without calling the network', async () => {
    const cache = new ResponseCache(new MemoryStorage());
    await cache.write('home', 'cached');
    let calls = 0;
    const states = await run(cache, async () => `n${++calls}`, { maxAgeMs: 60_000 });
    assert.equal(calls, 0);
    assert.deepEqual(states.at(-1)?.data, 'cached');
  });

  it('shows stale data first, then refreshes; keeps it if the refresh fails', async () => {
    let now = 0;
    const cache = new ResponseCache(new MemoryStorage(), { now: () => now });
    await cache.write('home', 'old');
    now = 120_000;
    const refreshed = await run(cache, async () => 'new', { maxAgeMs: 60_000 });
    assert.deepEqual(
      refreshed.map((s) => [s.data, s.stale]),
      [
        ['old', true],
        ['new', false],
      ],
    );
    now = 500_000;
    const offline = await run(cache, async () => {
      throw new NetworkError('offline', 'r');
    }, { maxAgeMs: 60_000 });
    const last = offline.at(-1)!;
    assert.deepEqual([last.data, last.stale, last.loading], ['new', true, false]);
    assert.ok(last.error instanceof NetworkError);
  });
});

describe('outbox', () => {
  it('persists the entry, with its idempotency key, before the first attempt', async () => {
    const storage = new MemoryStorage();
    let storedDuringSend = '';
    const outbox = new Outbox(storage, async () => {
      storedDuringSend = (await storage.getItem('pp-outbox:v1')) ?? '';
      return 'ok';
    });
    const entry = await outbox.enqueue('checkout', { costCenterId: 'cc_mkt' });
    await outbox.flush();
    assert.ok(storedDuringSend.includes(entry.idempotencyKey));
    assert.equal(outbox.entries().length, 0);
  });

  it('retries transient failures after a backoff, with the same idempotency key', async () => {
    let now = 0;
    let offline = true;
    const keys: string[] = [];
    const outbox = new Outbox(
      new MemoryStorage(),
      async (e) => {
        keys.push(e.idempotencyKey);
        if (offline) throw new NetworkError('offline', 'r');
        return 'ok';
      },
      { now: () => now, random: () => 1, baseDelayMs: 1_000 },
    );
    await outbox.enqueue('checkout', {});
    assert.deepEqual(await outbox.flush(), { sent: 0, pending: 1, failed: 0 });
    assert.deepEqual(await outbox.flush(), { sent: 0, pending: 1, failed: 0 }, 'not due yet');
    now = 1_000;
    offline = false;
    assert.deepEqual(await outbox.flush(), { sent: 1, pending: 0, failed: 0 });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  it('waits for the server-requested Retry-After before replaying', async () => {
    let now = 0;
    const outbox = new Outbox(
      new MemoryStorage(),
      async () => {
        if (now < 5_000) throw new ApiError(503, 'upstream_unavailable', 'circuit open', null, undefined, 5_000);
        return 'ok';
      },
      { now: () => now, random: () => 0, baseDelayMs: 1 },
    );
    await outbox.enqueue('checkout', {});
    assert.deepEqual(await outbox.flush(), { sent: 0, pending: 1, failed: 0 });
    now = 4_000;
    assert.deepEqual(await outbox.flush(), { sent: 0, pending: 1, failed: 0 }, 'not before Retry-After');
    now = 5_000;
    assert.deepEqual(await outbox.flush(), { sent: 1, pending: 0, failed: 0 });
  });

  it('stops retrying on permanent errors until the user retries', async () => {
    let attempt = 0;
    const outbox = new Outbox(new MemoryStorage(), async () => {
      if (++attempt === 1) throw new ApiError(409, 'items_unavailable', 'Out of stock', null);
      return 'ok';
    });
    const entry = await outbox.enqueue('checkout', {});
    assert.deepEqual(await outbox.flush(), { sent: 0, pending: 0, failed: 1 });
    await outbox.retry(entry.id);
    assert.deepEqual(await outbox.flush(), { sent: 1, pending: 0, failed: 0 });
  });

  it('replays an entry that was mid-send when the app was killed', async () => {
    const storage = new MemoryStorage();
    const interrupted = { id: 'obx_1', kind: 'checkout', payload: {}, idempotencyKey: 'idem_fixed_123', createdAt: 0, attempts: 1, nextAttemptAt: 0, status: 'sending', lastError: null };
    await storage.setItem('pp-outbox:v1', JSON.stringify([interrupted]));
    const keys: string[] = [];
    const outbox = new Outbox(storage, async (e) => void keys.push(e.idempotencyKey));
    await outbox.load();
    await outbox.flush();
    assert.deepEqual(keys, ['idem_fixed_123']);
  });

  it('shares one flush between concurrent callers', async () => {
    let calls = 0;
    const outbox = new Outbox(new MemoryStorage(), async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
    });
    await outbox.enqueue('checkout', {});
    await Promise.all([outbox.flush(), outbox.flush(), outbox.flush()]);
    assert.equal(calls, 1);
  });

  it('saves in order even when storage writes finish out of order', async () => {
    const data = new Map<string, string>();
    let writes = 0;
    const slowFirstWrite: KeyValueStorage = {
      getItem: async (key) => data.get(key) ?? null,
      removeItem: async (key) => void data.delete(key),
      setItem: async (key, value) => {
        const n = ++writes;
        await new Promise((r) => setTimeout(r, n === 1 ? 30 : 0));
        data.set(key, value);
      },
    };
    const outbox = new Outbox(slowFirstWrite, async () => 'ok');
    await Promise.all([outbox.enqueue('checkout', { n: 1 }), outbox.enqueue('checkout', { n: 2 })]);
    assert.equal((JSON.parse(data.get('pp-outbox:v1')!) as unknown[]).length, 2, 'a stale snapshot must not overwrite a newer one');
  });

  it('never sends what it could not save', async () => {
    const storage = new MemoryStorage();
    let broken = false;
    const flaky: KeyValueStorage = {
      getItem: (key) => storage.getItem(key),
      removeItem: (key) => storage.removeItem(key),
      setItem: async (key, value) => {
        if (broken) throw new Error('disk full');
        await storage.setItem(key, value);
      },
    };
    let sends = 0;
    const outbox = new Outbox(flaky, async () => void sends++);
    await outbox.enqueue('checkout', {});
    broken = true;
    assert.deepEqual(await outbox.flush(), { sent: 0, pending: 1, failed: 0 });
    assert.equal(sends, 0);
    await assert.rejects(outbox.enqueue('checkout', {}), /disk full/);
    assert.equal(outbox.entries().length, 1);
    broken = false;
    assert.deepEqual(await outbox.flush(), { sent: 1, pending: 0, failed: 0 });
  });
});
