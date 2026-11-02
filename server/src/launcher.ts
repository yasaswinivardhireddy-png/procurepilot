import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export type ServiceName = 'catalog' | 'orders' | 'assistant' | 'gateway';

export type LaunchOptions = {
  dataDir: string;
  ports?: Partial<Record<ServiceName, number>>;
  internalToken?: string;
  env?: Record<string, string | undefined>;
  serviceEnv?: Partial<Record<ServiceName, Record<string, string>>>;
  stdio?: 'inherit' | 'ignore';
  onUnexpectedExit?: (name: ServiceName, code: number | null) => void;
};

export type Launched = { urls: Record<ServiceName, string>; internalToken: string; stop(): Promise<void> };

const RUN = fileURLToPath(new URL('./run.ts', import.meta.url));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs} ms`);
}

// Starts each service as its own Node.js process (like separate deployments), wired together
// with service URLs and a shared service token. The gateway starts last.
export async function launchServices(options: LaunchOptions): Promise<Launched> {
  const ports = {
    catalog: options.ports?.catalog ?? (await freePort()),
    orders: options.ports?.orders ?? (await freePort()),
    assistant: options.ports?.assistant ?? (await freePort()),
    gateway: options.ports?.gateway ?? (await freePort()),
  };
  const urls = {
    catalog: `http://127.0.0.1:${ports.catalog}`,
    orders: `http://127.0.0.1:${ports.orders}`,
    assistant: `http://127.0.0.1:${ports.assistant}`,
    gateway: `http://127.0.0.1:${ports.gateway}`,
  };
  const internalToken = options.internalToken ?? randomBytes(24).toString('base64url');
  const children = new Map<ServiceName, ChildProcess>();
  let stopping = false;

  const start = (name: ServiceName) => {
    const env = options.env ?? process.env;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', RUN, name], {
      env: {
        ...env,
        PORT: String(ports[name]),
        HOST: name === 'gateway' ? (env.HOST ?? '127.0.0.1') : '127.0.0.1',
        INTERNAL_TOKEN: internalToken,
        DATA_DIR: options.dataDir,
        CATALOG_URL: urls.catalog,
        ORDERS_URL: urls.orders,
        ASSISTANT_URL: urls.assistant,
        ...options.serviceEnv?.[name],
      },
      stdio: options.stdio ?? 'inherit',
    });
    child.on('exit', (code) => {
      if (!stopping) options.onUnexpectedExit?.(name, code);
    });
    children.set(name, child);
  };

  const stop = async () => {
    stopping = true;
    await Promise.all(
      [...children.values()].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', () => resolve());
            child.kill();
          }),
      ),
    );
  };

  try {
    for (const name of ['catalog', 'orders', 'assistant'] as const) start(name);
    await Promise.all([waitForHealth(urls.catalog), waitForHealth(urls.orders), waitForHealth(urls.assistant)]);
    start('gateway');
    await waitForHealth(urls.gateway);
  } catch (error) {
    await stop();
    throw error;
  }
  return { urls, internalToken, stop };
}
