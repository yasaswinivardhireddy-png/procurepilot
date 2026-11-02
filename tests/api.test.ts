import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ApiError, createClient, type ProcurePilotClient } from '../sdk/src/index.ts';
import { startStack, type Stack } from '../server/src/stack.ts';

async function signIn(stack: Stack, userId: string, retries = 3): Promise<ProcurePilotClient> {
  const session = await createClient({ baseUrl: stack.gatewayUrl }).demoLogin(userId);
  return createClient({ baseUrl: stack.gatewayUrl, token: session.token, retry: { retries, baseDelayMs: 5 } });
}

const rejectsWith = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof ApiError && e.status === status && e.code === code);

const budget = async (client: ProcurePilotClient, costCenterId: string) => (await client.listBudgets()).items.find((b) => b.costCenterId === costCenterId)!;

describe('ordering API (all services, through the gateway)', () => {
  let stack: Stack;
  let asha: ProcurePilotClient;
  let ravi: ProcurePilotClient;
  let kiran: ProcurePilotClient;
  let vikram: ProcurePilotClient;
  let neha: ProcurePilotClient;

  before(async () => {
    stack = await startStack();
    [asha, ravi, kiran, vikram, neha] = await Promise.all(['u_asha', 'u_ravi', 'u_kiran', 'u_vikram', 'u_neha'].map((u) => signIn(stack, u)));
  });
  after(() => stack.close());

  it('requires a valid session, and services require the internal token', async () => {
    const anonymous = createClient({ baseUrl: stack.gatewayUrl, token: 'pp_not-a-real-token' });
    await rejectsWith(anonymous.getCart(), 401, 'unauthorized');
    const direct = await fetch(`${stack.orders.url}/v1/cart`, { headers: { 'x-user-id': 'u_asha' } });
    assert.equal(direct.status, 401);
  });

  it('places small orders immediately and commits the budget', async () => {
    const before = await budget(asha, 'cc_mkt');
    await asha.setCartItem('OFF-A4-JK75', 10);
    const order = await asha.checkout({ costCenterId: 'cc_mkt', poNumber: 'PO-1' });
    assert.equal(order.status, 'PLACED');
    assert.equal(order.total, 318_136);
    assert.deepEqual(order.events.map((e) => e.type), ['CREATED', 'AUTO_APPROVED', 'PLACED']);
    assert.equal((await budget(asha, 'cc_mkt')).committed, before.committed + order.total);
    assert.equal((await asha.getCart()).itemCount, 0, 'checkout empties the cart');
  });

  it('creates exactly one order when the same checkout is sent concurrently', async () => {
    const countBefore = (await asha.listOrders()).total;
    await asha.setCartItem('OFF-PEN-REY10', 2);
    const results = await Promise.all(Array.from({ length: 5 }, () => asha.checkout({ costCenterId: 'cc_mkt' }, { idempotencyKey: 'idem_same_checkout' })));
    assert.equal(new Set(results.map((o) => o.id)).size, 1);
    assert.equal((await asha.listOrders()).total, countBefore + 1);
  });

  it('rejects an idempotency key reused for a different request', async () => {
    await asha.setCartItem('OFF-NB-CLS6', 1);
    await asha.checkout({ costCenterId: 'cc_mkt', poNumber: 'PO-A' }, { idempotencyKey: 'idem_reuse_test' });
    await rejectsWith(asha.checkout({ costCenterId: 'cc_mkt', poNumber: 'PO-B' }, { idempotencyKey: 'idem_reuse_test' }), 422, 'idempotency_key_reused');
  });

  it('routes an order through manager and IT approval, then commits the budget', async () => {
    const before = await budget(asha, 'cc_mkt');
    await asha.setCartItem('IT-MON-P2425H', 2);
    const preview = await asha.previewOrder('cc_mkt');
    assert.deepEqual(preview.requiredApprovals.map((a) => a.role), ['MANAGER', 'IT_ADMIN']);
    const order = await asha.checkout({ costCenterId: 'cc_mkt' });
    assert.equal(order.status, 'PENDING_APPROVAL');
    assert.equal((await budget(asha, 'cc_mkt')).reserved, before.reserved + order.total);

    assert.ok((await ravi.listApprovals()).items.some((o) => o.id === order.id));
    assert.ok(!(await kiran.listApprovals()).items.some((o) => o.id === order.id), 'IT sees it only after the manager');
    const afterManager = await ravi.approveOrder(order.id, { version: order.version, comment: 'OK' });
    assert.deepEqual([afterManager.status, afterManager.currentApproverRole], ['PENDING_APPROVAL', 'IT_ADMIN']);
    await rejectsWith(ravi.approveOrder(order.id, { version: afterManager.version }), 403, 'not_your_step');
    const placed = await kiran.approveOrder(order.id, { version: afterManager.version });
    assert.equal(placed.status, 'PLACED');
    assert.deepEqual(placed.approvals.map((a) => a.status), ['APPROVED', 'APPROVED']);
    const afterBudget = await budget(asha, 'cc_mkt');
    assert.equal(afterBudget.reserved, before.reserved);
    assert.equal(afterBudget.committed, before.committed + order.total);
  });

  it('escalates the order of a manager buying for their own cost center to Finance', async () => {
    await ravi.setCartItem('FUR-CHR-GSSEOUL', 3);
    const own = await ravi.checkout({ costCenterId: 'cc_mkt' });
    assert.equal(own.currentApproverRole, 'FINANCE', 'no other manager could approve, so the step escalates');
    assert.match(own.approvals[0]!.reason, /escalated: no other manager can approve/);
    await rejectsWith(ravi.approveOrder(own.id, { version: own.version }), 403, 'self_approval_forbidden');
    await rejectsWith(ravi.cancelOrder(own.id, own.version + 1), 409, 'version_conflict');
    await rejectsWith(asha.getOrder(own.id), 404, 'order_not_found');
    const cancelled = await ravi.cancelOrder(own.id, own.version);
    assert.equal(cancelled.status, 'CANCELLED');
  });

  it('never charges a different total or policy than the buyer reviewed', async () => {
    await asha.clearCart();
    await asha.setCartItem('OFF-STK-3M12', 2);
    const cart = await asha.getCart();
    await rejectsWith(asha.checkout({ costCenterId: 'cc_mkt', expectedTotal: cart.total - 1 }), 409, 'price_changed');
    await rejectsWith(asha.checkout({ costCenterId: 'cc_mkt', expectedTotal: cart.total, expectedPolicyVersion: 999 }), 409, 'policy_changed');
    const order = await asha.checkout({ costCenterId: 'cc_mkt', expectedTotal: cart.total, expectedPolicyVersion: 4 });
    assert.equal(order.total, cart.total);
  });

  it('replays a checkout from the order itself after idempotency records are purged', async () => {
    await asha.setCartItem('OFF-MKR-CAM10', 1);
    const first = await asha.checkout({ costCenterId: 'cc_mkt' }, { idempotencyKey: 'idem_long_offline' });
    stack.orders.store.purgeIdempotency(new Date(Date.now() + 60_000).toISOString());
    const replayed = await asha.checkout({ costCenterId: 'cc_mkt' }, { idempotencyKey: 'idem_long_offline' });
    assert.equal(replayed.id, first.id);
    await rejectsWith(asha.checkout({ costCenterId: 'cc_ops' }, { idempotencyKey: 'idem_long_offline' }), 422, 'idempotency_key_reused');
  });

  it('requires a reason to reject and releases the reserved budget', async () => {
    const before = await budget(vikram, 'cc_eng');
    await vikram.setCartItem('IT-LAP-E14G6', 2);
    const order = await vikram.checkout({ costCenterId: 'cc_eng' });
    await rejectsWith(neha.rejectOrder(order.id, { version: order.version, comment: '' }), 400, 'comment_required');
    const rejected = await neha.rejectOrder(order.id, { version: order.version, comment: 'One laptop is enough' });
    assert.equal(rejected.status, 'REJECTED');
    assert.deepEqual(rejected.approvals.map((a) => a.status), ['REJECTED', 'SKIPPED']);
    assert.equal((await budget(vikram, 'cc_eng')).reserved, before.reserved);
  });

  it('sends orders above the remaining budget to Finance', async () => {
    await asha.setCartItem('FUR-DSK-FL120', 7);
    const preview = await asha.previewOrder('cc_ops');
    assert.deepEqual(preview.requiredApprovals.map((a) => a.role), ['MANAGER', 'FINANCE']);
    assert.match(preview.requiredApprovals[1]!.reason, /remaining cost-center budget/);
    await asha.clearCart();
  });

  it('fails safely when the cart changed after the buyer reviewed it', async () => {
    await asha.setCartItem('CLN-LIZ-5L', 1);
    await rejectsWith(asha.checkout({ costCenterId: 'cc_mkt', expectedItems: [{ sku: 'CLN-LIZ-5L', qty: 2 }] }), 409, 'cart_changed');
    await asha.clearCart();
  });

  it('applies an idempotent add-to-cart and reorder exactly once', async () => {
    await asha.clearCart();
    await asha.addToCart('PAN-TEA-TAJ1KG', 3, { idempotencyKey: 'idem_add_tea' });
    const again = await asha.addToCart('PAN-TEA-TAJ1KG', 3, { idempotencyKey: 'idem_add_tea' });
    assert.equal(again.lines.find((l) => l.sku === 'PAN-TEA-TAJ1KG')!.qty, 3);
    const placed = (await asha.listOrders({ status: 'PLACED' })).items[0]!;
    const full = await asha.getOrder(placed.id);
    await asha.clearCart();
    await asha.reorder(placed.id, { idempotencyKey: 'idem_reorder_1' });
    const cart = await asha.reorder(placed.id, { idempotencyKey: 'idem_reorder_1' });
    assert.deepEqual(
      cart.lines.map((l) => [l.sku, l.qty]),
      full.lines.map((l) => [l.sku, l.qty]),
    );
    await asha.clearCart();
  });

  it('keeps the budget ledger balanced', async () => {
    const audit = (await (await fetch(`${stack.orders.url}/internal/audit`, { headers: { 'x-internal-token': stack.internalToken } })).json()) as {
      balanced: boolean;
      duplicateIdempotencyKeys: number;
    };
    assert.equal(audit.balanced, true);
    assert.equal(audit.duplicateIdempotencyKeys, 0);
  });
});

describe('gateway authentication', () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack();
  });
  after(() => stack.close());

  it('makes logout idempotent', async () => {
    const client = await signIn(stack, 'u_vikram', 0);
    await client.logout();
    await client.logout();
    await rejectsWith(client.getCart(), 401, 'unauthorized');
  });

  it('throttles repeated failed sign-ins from one address', async () => {
    const guesser = createClient({ baseUrl: stack.gatewayUrl, token: 'pp_guess', retry: { retries: 0 } });
    let throttled = false;
    for (let i = 0; i < 30 && !throttled; i++) {
      await guesser.getCart().catch((e: unknown) => {
        throttled = e instanceof ApiError && e.status === 429;
      });
    }
    assert.ok(throttled, 'bad tokens are rate limited');
  });
});

describe('gateway rate limiting', () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack({ rateLimit: { capacity: 3, refillPerSec: 1 } });
  });
  after(() => stack.close());

  it('returns 429 with Retry-After once a session exceeds its budget', async () => {
    const client = await signIn(stack, 'u_asha', 0);
    for (let i = 0; i < 3; i++) await client.listCategories();
    await assert.rejects(client.listCategories(), (e: unknown) => e instanceof ApiError && e.status === 429 && e.code === 'rate_limited');
  });
});
