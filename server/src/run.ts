import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startAssistantService } from './assistant/service.ts';
import { startCatalogService } from './catalog/service.ts';
import { startGateway } from './gateway/service.ts';
import { startOrdersService } from './orders/service.ts';
import { faultConfigFromEnv } from './shared/faults.ts';
import type { RunningService } from './shared/http.ts';

// Runs one service as its own process: node server/src/run.ts <catalog|orders|assistant|gateway>
const env = process.env;
const name = process.argv[2] ?? env.SERVICE;

function required(key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function envInt(key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

const dataDir = resolve(env.DATA_DIR ?? '.data');
mkdirSync(dataDir, { recursive: true });
const common = { port: envInt('PORT', 0), host: env.HOST ?? '127.0.0.1', internalToken: required('INTERNAL_TOKEN') };

let service: RunningService;
switch (name) {
  case 'catalog':
    service = await startCatalogService(common);
    break;
  case 'orders':
    service = await startOrdersService({
      ...common,
      dbPath: join(dataDir, 'orders.db'),
      catalogUrl: required('CATALOG_URL'),
      watchPolicy: env.WATCH_POLICY !== '0',
      faults: faultConfigFromEnv(env),
      loadTestUsers: envInt('LOADTEST_USERS', 0),
    });
    break;
  case 'assistant':
    service = await startAssistantService({ ...common, dbPath: join(dataDir, 'assistant.db'), catalogUrl: required('CATALOG_URL'), ordersUrl: required('ORDERS_URL') });
    break;
  case 'gateway': {
    const webDist = env.WEB_DIST ?? (existsSync('mobile/dist/index.html') ? 'mobile/dist' : null);
    service = await startGateway({
      ...common,
      dbPath: join(dataDir, 'gateway.db'),
      catalogUrl: required('CATALOG_URL'),
      ordersUrl: required('ORDERS_URL'),
      assistantUrl: required('ASSISTANT_URL'),
      demoLogin: env.DEMO_LOGIN !== '0',
      webDist,
      rateLimit: { capacity: envInt('RATE_LIMIT_BURST', 60), refillPerSec: envInt('RATE_LIMIT_RPS', 20) },
    });
    break;
  }
  default:
    throw new Error(`Unknown service "${name}". Use catalog, orders, assistant or gateway.`);
}

const shutdown = async () => {
  await service.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
