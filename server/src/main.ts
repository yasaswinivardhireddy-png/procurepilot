import { resolve } from 'node:path';
import { seedDemo } from './demo-seed.ts';
import { launchServices } from './launcher.ts';

// npm start: runs the four services as separate processes on fixed local ports.
const env = process.env;
const port = (key: string, fallback: number) => Number(env[key] ?? fallback);

process.env.LOG_FORMAT ??= process.stdout.isTTY ? 'pretty' : 'json';

const stack = await launchServices({
  dataDir: resolve(env.DATA_DIR ?? '.data'),
  ports: { catalog: port('CATALOG_PORT', 7001), orders: port('ORDERS_PORT', 7002), assistant: port('ASSISTANT_PORT', 7003), gateway: port('PORT', 8080) },
  internalToken: env.INTERNAL_TOKEN,
  onUnexpectedExit: (name, code) => {
    process.stderr.write(`${name} exited (${code}); stopping all services\n`);
    void stack.stop().then(() => process.exit(1));
  },
});

const shutdown = () => void stack.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (env.SEED_DEMO !== '0' && (await seedDemo(stack.urls.gateway))) process.stdout.write('Seeded demo orders and approvals.\n');

const gateway = stack.urls.gateway;
process.stdout.write(
  [
    '',
    `ProcurePilot is running. Gateway: ${gateway}  (metrics: ${gateway}/metrics)`,
    `Assistant: ${env.GEMINI_API_KEY ? `Gemini (${env.GEMINI_MODEL || 'gemini-3.5-flash'}) with offline fallback` : 'offline planner (set GEMINI_API_KEY to use Gemini)'}`,
    'Demo users: u_asha, u_vikram (requesters), u_ravi, u_neha (managers), u_kiran (IT admin), u_meera (finance)',
    'Mobile app: cd mobile && npm start   (or build the web app with: npm run build:web)',
    '',
  ].join('\n'),
);
