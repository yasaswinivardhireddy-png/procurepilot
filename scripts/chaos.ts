import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, Outbox, createClient, type Order } from '../sdk/src/index.ts';
import { launchServices } from '../server/src/launcher.ts';
import { fetchAudit, loadUser, machine, metricSum, removeDir } from './lib.ts';

// Chaos test: 30% of writes to the orders service fail, half before the change is committed and
// half after it (the client never sees the response). Buyers check out through the SDK's outbox
// exactly as the app does. Every checkout must create exactly one order.
const quick = process.argv.includes('--quick');
const BUYERS = quick ? 8 : 16;
const PER_BUYER = quick ? 8 : 20;
const FAULT_RATE = 0.3;
const EXPECTED = BUYERS * PER_BUYER;

const dataDir = mkdtempSync(join(tmpdir(), 'pp-chaos-'));
const stack = await launchServices({
  dataDir,
  env: { ...process.env, LOG_LEVEL: 'error', RATE_LIMIT_BURST: '1000000', RATE_LIMIT_RPS: '1000000', WATCH_POLICY: '0' },
  serviceEnv: { orders: { FAULT_RATE: String(FAULT_RATE), FAULT_MODE: 'mixed', LOADTEST_USERS: String(BUYERS) } },
});
let failed = true;

try {
  const baseUrl = stack.urls.gateway;
  let checkoutAttempts = 0;
  let checkoutFailures = 0;
  let outboxReplays = 0;
  const started = performance.now();

  const created = await Promise.all(
    Array.from({ length: BUYERS }, async (_, i) => {
      const session = await createClient({ baseUrl }).demoLogin(loadUser(i));
      const cartClient = createClient({ baseUrl, token: session.token, retry: { retries: 10, baseDelayMs: 5, maxDelayMs: 50 } });
      const checkoutClient = createClient({
        baseUrl,
        token: session.token,
        retry: { retries: 1, baseDelayMs: 5, maxDelayMs: 50 },
        onRequest: (info) => {
          if (info.method !== 'POST' || info.path !== '/v1/orders') return;
          checkoutAttempts++;
          if (info.status !== 201) checkoutFailures++;
        },
      });
      const ids: string[] = [];
      const outbox = new Outbox(
        new MemoryStorage(),
        (entry) => checkoutClient.checkout(entry.payload as { costCenterId: string }, { idempotencyKey: entry.idempotencyKey }),
        { baseDelayMs: 5, maxDelayMs: 50 },
      );
      outbox.subscribe((event) => {
        if (event.type === 'sent') ids.push((event.result as Order).id);
      });
      for (let n = 0; n < PER_BUYER; n++) {
        await cartClient.setCartItem('OFF-A4-JK75', 1 + (n % 5));
        await outbox.enqueue('checkout', { costCenterId: 'cc_load' });
        const deadline = Date.now() + 60_000;
        let firstFlush = true;
        while (outbox.entries().length > 0) {
          if (Date.now() > deadline) throw new Error('outbox did not drain within 60 s');
          const { sent } = await outbox.flush();
          if (!firstFlush && sent > 0) outboxReplays++;
          firstFlush = false;
          if (outbox.entries().length > 0) await new Promise((r) => setTimeout(r, 10));
        }
      }
      return ids;
    }),
  );

  const ids = created.flat();
  const seconds = (performance.now() - started) / 1000;
  const metrics = await (await fetch(`${stack.urls.orders}/metrics`)).text();
  const audit = await fetchAudit(stack.urls.orders, stack.internalToken);
  const before = metricSum(metrics, 'faults_injected_total', 'when="before"');
  const afterCommit = metricSum(metrics, 'faults_injected_total', 'when="after"');
  const lostCheckouts = metricSum(metrics, 'faults_injected_total', 'when="after"', 'route="POST /v1/orders"');
  const replays = metricSum(metrics, 'idempotent_replays_total', 'route="/v1/orders"');
  const unique = new Set(ids).size;
  failed = !(ids.length === EXPECTED && unique === EXPECTED && audit.orders === EXPECTED && audit.balanced && audit.duplicateIdempotencyKeys === 0);

  process.stdout.write(
    [
      '',
      `ProcurePilot chaos test: ${EXPECTED} checkouts from ${BUYERS} concurrent buyers; ${FAULT_RATE * 100}% of writes fail`,
      `Machine: ${machine()}`,
      '',
      '| Measure | Result |',
      '| --- | ---: |',
      `| Injected failures before commit | ${before} |`,
      `| Injected failures after commit (response lost) | ${afterCommit} (${lostCheckouts} on checkout) |`,
      `| Checkout attempts sent by the SDK | ${checkoutAttempts} (${checkoutFailures} failed) |`,
      `| Checkouts completed by an outbox replay | ${outboxReplays} |`,
      `| Retries answered from the idempotency store | ${replays} |`,
      `| Orders created | **${audit.orders} of ${EXPECTED}** |`,
      `| Duplicate orders | **${ids.length - unique + audit.duplicateIdempotencyKeys}** |`,
      `| Budget ledger audit | ${audit.balanced ? 'balanced' : 'NOT balanced'} |`,
      '',
      `Finished in ${seconds.toFixed(1)} s. Result: ${failed ? 'FAILED' : 'passed'}`,
      '',
    ].join('\n'),
  );
} finally {
  await stack.stop();
  removeDir(dataDir);
}
process.exit(failed ? 1 : 0);
