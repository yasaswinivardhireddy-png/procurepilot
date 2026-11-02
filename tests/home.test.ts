import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createClient } from '../sdk/src/index.ts';
import type { User } from '../sdk/src/types.ts';
import { composeHome, isFlagEnabled, loadHomeConfig, parseCapabilities, type HomeFetchers } from '../server/src/gateway/home.ts';
import { fileURLToPath } from 'node:url';
import { startStack, type Stack } from '../server/src/stack.ts';

const CONFIG = fileURLToPath(new URL('../server/config/', import.meta.url));
const { layout, flags } = loadHomeConfig(`${CONFIG}home-layout.json`, `${CONFIG}flags.json`);

const requester: User = { id: 'u_asha', name: 'Asha Reddy', title: 'Marketing Executive', role: 'REQUESTER', costCenterIds: ['cc_mkt'] };
const manager: User = { id: 'u_ravi', name: 'Ravi Kumar', title: 'Marketing Manager', role: 'MANAGER', costCenterIds: ['cc_mkt'] };
const product = { sku: 'OFF-A4-JK75', title: 'Paper', brand: 'JK', category: 'Office Supplies', unit: 'ream', unitPrice: 29_900, gstRateBps: 1200, gstInvoice: true, deliveryDays: 1, rating: 4.5, inStock: true, bestTierDiscountBps: 1200 };

const fetchers = (overrides: Partial<HomeFetchers> = {}): HomeFetchers => ({
  budgets: async () => [{ costCenterId: 'cc_mkt', name: 'Marketing', budget: 100, committed: 10, reserved: 5, available: 85 }],
  approvals: async () => ({ total: 2 }),
  buyAgain: async () => [{ ...product, suggestedQty: 20 }],
  deals: async () => [product],
  categories: async () => [{ name: 'Office Supplies', count: 10 }],
  recentOrders: async () => [],
  ...overrides,
});

const compose = (user: User, f = fetchers(), capabilities: Map<string, number> | null = null) =>
  composeHome({ user, layout, flags, fetchers: f, capabilities, timeoutMs: 50, now: new Date('2026-11-02T04:00:00Z') });

describe('server-driven home screen', () => {
  it('uses the layout for the user role and drops empty sections', async () => {
    const buyer = await compose(requester);
    assert.deepEqual(
      buyer.sections.map((s) => s.id),
      ['greeting', 'pendingApprovals', 'budgetSummary', 'buyAgain', 'assistantPrompts', 'deals', 'categories'],
    );
    assert.equal(buyer.sections[0]!.props.title, 'Good morning, Asha');
    const approver = await compose(manager, fetchers({ approvals: async () => ({ total: 0 }) }));
    assert.ok(!approver.sections.some((s) => s.id === 'pendingApprovals'), 'no banner when nothing is pending');
    assert.deepEqual(approver.degraded, []);
  });

  it('degrades only the sections whose data failed or timed out', async () => {
    const home = await compose(
      requester,
      fetchers({
        budgets: async () => {
          throw new Error('orders down');
        },
        deals: () => new Promise(() => {}),
      }),
    );
    assert.deepEqual(home.degraded, ['budgetSummary', 'deals']);
    assert.ok(home.sections.some((s) => s.id === 'buyAgain'));
  });

  it('never sends sections an older app cannot render', async () => {
    const capabilities = parseCapabilities('greeting@1, banner@1, productCarousel@1, categoryGrid@1');
    const home = await compose(requester, fetchers(), capabilities);
    assert.deepEqual(home.skipped, ['budgetSummary', 'assistantPrompts', 'recentOrders']);
    assert.ok(home.sections.every((s) => capabilities!.has(s.type)));
  });

  it('buckets users deterministically for percentage rollouts', () => {
    const rule = { half: { enabled: true, rolloutPercent: 50 } };
    const users = Array.from({ length: 400 }, (_, i) => ({ id: `u_${i}`, role: 'REQUESTER' as const }));
    const enabled = users.filter((u) => isFlagEnabled(rule, 'half', u)).length;
    assert.ok(enabled > 150 && enabled < 250, `about half should be enabled, got ${enabled}`);
    assert.equal(isFlagEnabled(rule, 'half', users[7]!), isFlagEnabled(rule, 'half', users[7]!));
    assert.equal(isFlagEnabled({ off: { enabled: false, rolloutPercent: 100 } }, 'off', users[0]!), false);
    assert.equal(isFlagEnabled({ mgr: { enabled: true, rolloutPercent: 100, roles: ['MANAGER'] } }, 'mgr', users[0]!), false);
  });
});

describe('home screen with a service outage', () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack({ homeSectionTimeoutMs: 500 });
  });
  after(() => stack.close());

  it('still renders when the catalog service is down', async () => {
    const session = await createClient({ baseUrl: stack.gatewayUrl }).demoLogin('u_asha');
    const client = createClient({ baseUrl: stack.gatewayUrl, token: session.token, retry: { retries: 0 } });
    await client.setCartItem('OFF-A4-JK75', 2);
    await client.checkout({ costCenterId: 'cc_mkt' });
    await stack.catalog.close();
    const home = await client.home();
    assert.ok(home.sections.some((s) => s.id === 'greeting'));
    assert.ok(home.sections.some((s) => s.id === 'budgetSummary'), 'orders-backed sections still render');
    for (const id of ['buyAgain', 'deals', 'categories']) assert.ok(home.degraded.includes(id), `${id} should be degraded`);
  });
});
