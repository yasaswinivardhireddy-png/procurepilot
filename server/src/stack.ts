import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { OfflinePlanner } from './assistant/providers/offline.ts';
import type { LlmProvider } from './assistant/llm.ts';
import { startAssistantService, type AssistantService } from './assistant/service.ts';
import { startCatalogService } from './catalog/service.ts';
import { startGateway, type GatewayService } from './gateway/service.ts';
import { startOrdersService, type OrdersService } from './orders/service.ts';
import type { FaultConfig } from './shared/faults.ts';
import type { RunningService } from './shared/http.ts';
import type { LogLevel } from './shared/log.ts';

export type Stack = {
  gatewayUrl: string;
  internalToken: string;
  catalog: RunningService;
  orders: OrdersService;
  assistant: AssistantService;
  gateway: GatewayService;
  close(): Promise<void>;
};

export type StackOptions = {
  logLevel?: LogLevel;
  dataDir?: string;
  provider?: LlmProvider;
  faults?: FaultConfig;
  rateLimit?: { capacity: number; refillPerSec: number };
  homeSectionTimeoutMs?: number;
  loadTestUsers?: number;
};

// Starts all four services in this process on ephemeral ports (used by the integration tests).
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const internalToken = randomBytes(16).toString('hex');
  const logLevel = options.logLevel ?? 'silent';
  const dbPath = (name: string) => (options.dataDir ? join(options.dataDir, `${name}.db`) : ':memory:');
  const catalog = await startCatalogService({ port: 0, internalToken, logLevel });
  const orders = await startOrdersService({
    port: 0,
    internalToken,
    logLevel,
    dbPath: dbPath('orders'),
    catalogUrl: catalog.url,
    faults: options.faults,
    loadTestUsers: options.loadTestUsers,
  });
  const assistant = await startAssistantService({
    port: 0,
    internalToken,
    logLevel,
    dbPath: dbPath('assistant'),
    catalogUrl: catalog.url,
    ordersUrl: orders.url,
    provider: options.provider ?? new OfflinePlanner(),
  });
  const gateway = await startGateway({
    port: 0,
    internalToken,
    logLevel,
    dbPath: dbPath('gateway'),
    catalogUrl: catalog.url,
    ordersUrl: orders.url,
    assistantUrl: assistant.url,
    rateLimit: options.rateLimit ?? { capacity: 10_000, refillPerSec: 10_000 },
    homeSectionTimeoutMs: options.homeSectionTimeoutMs,
  });
  return {
    gatewayUrl: gateway.url,
    internalToken,
    catalog,
    orders,
    assistant,
    gateway,
    close: async () => {
      await gateway.close();
      await assistant.close();
      await orders.close();
      await catalog.close();
    },
  };
}
