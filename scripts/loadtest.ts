import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type ProcurePilotClient } from '../sdk/src/index.ts';
import { PRODUCTS } from '../server/src/catalog/data.ts';
import { launchServices } from '../server/src/launcher.ts';
import { fetchAudit, loadUser, machine, percentile, removeDir } from './lib.ts';

// Drives the full stack (four separate processes) with a mobile-like traffic mix:
// 30% home screen, 30% search, 15% product page, 10% cart, 10% cart edits, 5% checkout.
const quick = process.argv.includes('--quick');
const VUS = quick ? 16 : 64;
const WARMUP_MS = quick ? 1_000 : 3_000;
const DURATION_MS = quick ? 5_000 : 20_000;
const QUERIES = ['a4 paper', 'gel pens', 'wireless mouse', 'monitor', 'ergonomic chair', 'tea', 'coffee', 'gloves', 'floor cleaner', 'notebook', 'stapl', 'hdmi cable'];
const SKUS = PRODUCTS.map((p) => p.sku);
const CART_SKUS = ['OFF-A4-JK75', 'OFF-PEN-REY10', 'PAN-TEA-TAJ1KG', 'CLN-DET-HW15', 'OFF-STK-3M12', 'SAF-GLV-NIT100'];
const CAPABILITIES = ['greeting@1', 'banner@1', 'budgetSummary@1', 'productCarousel@1', 'promptChips@1', 'categoryGrid@1', 'orderList@1'];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

const dataDir = mkdtempSync(join(tmpdir(), 'pp-load-'));
const stack = await launchServices({
  dataDir,
  env: { ...process.env, LOG_LEVEL: 'warn', RATE_LIMIT_BURST: '1000000', RATE_LIMIT_RPS: '1000000', WATCH_POLICY: '0' },
  serviceEnv: { orders: { LOADTEST_USERS: String(VUS) } },
});
let failed = false;

try {
  const baseUrl = stack.urls.gateway;
  const clients: ProcurePilotClient[] = await Promise.all(
    Array.from({ length: VUS }, async (_, i) => {
      const session = await createClient({ baseUrl }).demoLogin(loadUser(i));
      return createClient({ baseUrl, token: session.token, retry: { retries: 0 }, sduiCapabilities: CAPABILITIES });
    }),
  );

  const samples = new Map<string, number[]>();
  const errors: string[] = [];
  let measuring = false;
  const timed = async (name: string, fn: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      await fn();
      if (measuring) {
        const list = samples.get(name) ?? [];
        list.push(performance.now() - started);
        samples.set(name, list);
      }
    } catch (error) {
      if (measuring) errors.push(`${name}: ${(error as Error).message}`);
    }
  };

  const startedAt = Date.now();
  const measureFrom = startedAt + WARMUP_MS;
  const deadline = measureFrom + DURATION_MS;
  setTimeout(() => (measuring = true), WARMUP_MS);
  let measuredMs = 0;
  setTimeout(() => (measuredMs = Date.now() - measureFrom), WARMUP_MS + DURATION_MS);

  await Promise.all(
    clients.map(async (client) => {
      while (Date.now() < deadline) {
        const r = Math.random();
        if (r < 0.3) await timed('GET /v1/home', () => client.home());
        else if (r < 0.6) await timed('GET /v1/products?q=', () => client.searchProducts({ q: pick(QUERIES), limit: 20 }));
        else if (r < 0.75) await timed('GET /v1/products/:sku', () => client.getProduct(pick(SKUS)));
        else if (r < 0.85) await timed('GET /v1/cart', () => client.getCart());
        else if (r < 0.95) await timed('PUT /v1/cart/items/:sku', () => client.setCartItem(pick(CART_SKUS), 1 + Math.floor(Math.random() * 5)));
        else {
          await timed('PUT /v1/cart/items/:sku', () => client.setCartItem(pick(CART_SKUS), 2));
          await timed('POST /v1/orders (checkout)', () => client.checkout({ costCenterId: 'cc_load' }));
        }
      }
    }),
  );
  measuredMs ||= Date.now() - measureFrom;

  let total = 0;
  const rows: string[] = [];
  for (const [name, list] of [...samples.entries()].sort((a, b) => b[1].length - a[1].length)) {
    list.sort((a, b) => a - b);
    total += list.length;
    rows.push(`| ${name} | ${list.length} | ${percentile(list, 0.5).toFixed(1)} | ${percentile(list, 0.95).toFixed(1)} | ${percentile(list, 0.99).toFixed(1)} |`);
  }
  const all = [...samples.values()].flat().sort((a, b) => a - b);
  const audit = await fetchAudit(stack.urls.orders, stack.internalToken);
  const throughput = total / (measuredMs / 1000);

  process.stdout.write(
    [
      '',
      `ProcurePilot load test: ${VUS} virtual users for ${DURATION_MS / 1000} s (after ${WARMUP_MS / 1000} s warm-up); 4 services as separate processes`,
      `Machine: ${machine()}`,
      '',
      '| Endpoint | Requests | p50 ms | p95 ms | p99 ms |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...rows,
      `| **All requests** | **${total}** | **${percentile(all, 0.5).toFixed(1)}** | **${percentile(all, 0.95).toFixed(1)}** | **${percentile(all, 0.99).toFixed(1)}** |`,
      '',
      `Throughput: ${throughput.toFixed(0)} requests/s through the gateway; errors: ${errors.length}`,
      `Budget ledger audit: ${audit.balanced ? 'balanced' : 'NOT balanced'} across ${audit.orders} orders; duplicate idempotency keys: ${audit.duplicateIdempotencyKeys}`,
      ...errors.slice(0, 5).map((e) => `  error: ${e}`),
      '',
    ].join('\n'),
  );
  failed = errors.length > 0 || !audit.balanced;
} finally {
  await stack.stop();
  removeDir(dataDir);
}
process.exit(failed ? 1 : 0);
