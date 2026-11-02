import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MemoryStorage, Outbox, createClient } from '../sdk/src/index.ts';
import { startStack, type Stack } from '../server/src/stack.ts';

// Deterministic pseudo-random numbers so the injected faults are the same on every run.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('chaos: checkout under injected failures', () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack({ loadTestUsers: 4, faults: { rate: 0.3, mode: 'mixed', methods: ['POST', 'PUT', 'DELETE'], random: seeded(42) } });
  });
  after(() => stack.close());

  it('creates every order exactly once when 30% of writes fail before or after commit', async () => {
    const perUser = 10;
    const users = ['u_load_001', 'u_load_002', 'u_load_003', 'u_load_004'];
    const ids = await Promise.all(
      users.map(async (userId) => {
        const session = await createClient({ baseUrl: stack.gatewayUrl }).demoLogin(userId);
        // Cart edits are idempotent PUTs, so the SDK may retry them freely.
        const cartClient = createClient({ baseUrl: stack.gatewayUrl, token: session.token, retry: { retries: 10, baseDelayMs: 1, maxDelayMs: 5 } });
        // Checkouts get one quick retry in the SDK; anything still failing waits in the outbox.
        const checkoutClient = createClient({ baseUrl: stack.gatewayUrl, token: session.token, retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 5 } });
        const created: string[] = [];
        const outbox = new Outbox(
          new MemoryStorage(),
          (entry) => checkoutClient.checkout(entry.payload as { costCenterId: string }, { idempotencyKey: entry.idempotencyKey }),
          { baseDelayMs: 1, maxDelayMs: 5 },
        );
        outbox.subscribe((event) => {
          if (event.type === 'sent') created.push((event.result as { id: string }).id);
        });
        for (let i = 0; i < perUser; i++) {
          await cartClient.setCartItem('OFF-A4-JK75', 1 + i);
          await outbox.enqueue('checkout', { costCenterId: 'cc_load' });
          // Drain like the app does: keep flushing; an open circuit's Retry-After is waited out.
          const deadline = Date.now() + 20_000;
          while (outbox.entries().length > 0 && Date.now() < deadline) {
            await outbox.flush();
            if (outbox.entries().length > 0) await new Promise((r) => setTimeout(r, 5));
          }
          assert.equal(outbox.entries().length, 0, 'the outbox drains');
        }
        return created;
      }),
    );
    const created = ids.flat();
    assert.equal(created.length, users.length * perUser);
    assert.equal(new Set(created).size, created.length, 'no order was created twice');

    const audit = (await (await fetch(`${stack.orders.url}/internal/audit`, { headers: { 'x-internal-token': stack.internalToken } })).json()) as {
      balanced: boolean;
      orders: number;
    };
    assert.equal(audit.orders, users.length * perUser);
    assert.equal(audit.balanced, true);
    const metrics = await (await fetch(`${stack.orders.url}/metrics`)).text();
    assert.match(metrics, /faults_injected_total\{when="after",route="POST \/v1\/orders"\} [1-9]/, 'some checkouts committed but lost their response');
    assert.match(metrics, /idempotent_replays_total\{route="\/v1\/orders"\} [1-9]/, 'those retries were answered from the idempotency store');
  });
});
