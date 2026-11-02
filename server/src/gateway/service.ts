import { fileURLToPath } from 'node:url';
import type { Budget, BuyAgainItem, Category, OrderSummary, Paged, ProductSummary, SearchResult, User } from '../../../sdk/src/types.ts';
import { HttpError, Router, startService, type Handler, type Middleware, type Request, type RunningService } from '../shared/http.ts';
import { createLogger, type LogLevel } from '../shared/log.ts';
import { Registry } from '../shared/metrics.ts';
import { TokenBucket, TtlCache, Upstream } from '../shared/resilience.ts';
import { parseBody, type Schema } from '../shared/validate.ts';
import { composeHome, loadHomeConfig, parseCapabilities, type HomeFetchers } from './home.ts';
import { SessionStore } from './sessions.ts';
import { staticFiles } from './static.ts';

const CONFIG_DIR = fileURLToPath(new URL('../../config/', import.meta.url));

export type GatewayConfig = {
  port: number;
  host?: string;
  internalToken: string;
  dbPath: string;
  catalogUrl: string;
  ordersUrl: string;
  assistantUrl: string;
  logLevel?: LogLevel;
  demoLogin?: boolean;
  corsOrigin?: string | null;
  webDist?: string | null;
  rateLimit?: { capacity: number; refillPerSec: number };
  authFailureLimit?: { capacity: number; refillPerSec: number };
  homeLayoutPath?: string;
  flagsPath?: string;
  homeSectionTimeoutMs?: number;
};

export type GatewayService = RunningService & {
  sessions: SessionStore;
  registry: Registry;
  upstreams: { catalog: Upstream; orders: Upstream; assistant: Upstream };
};

const LOGIN_SCHEMA: Schema = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: { userId: { type: 'string', pattern: '^u_[a-z0-9_]{1,40}$' } },
};

const PUBLIC_ROUTES = new Set(['/v1/auth/demo-users', '/v1/auth/demo-login', '/v1/auth/logout']);
const PASS_THROUGH_HEADERS = ['idempotent-replayed', 'retry-after'];

const bearer = (req: Request): string => {
  const header = req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

// The mobile backend-for-frontend: one public API for the app over the internal services.
export async function startGateway(config: GatewayConfig): Promise<GatewayService> {
  const logger = createLogger('gateway', config.logLevel);
  const registry = new Registry();
  const sessions = new SessionStore(config.dbPath);
  const upstream = (name: string, baseUrl: string, timeoutMs: number) =>
    new Upstream({ name, baseUrl, internalToken: config.internalToken, registry, logger, timeoutMs });
  const catalog = upstream('catalog', config.catalogUrl, 3_000);
  const orders = upstream('orders', config.ordersUrl, 5_000);
  const assistant = upstream('assistant', config.assistantUrl, 60_000);
  const { layout, flags } = loadHomeConfig(config.homeLayoutPath ?? `${CONFIG_DIR}home-layout.json`, config.flagsPath ?? `${CONFIG_DIR}flags.json`);
  const limiter = new TokenBucket({ capacity: config.rateLimit?.capacity ?? 60, refillPerSec: config.rateLimit?.refillPerSec ?? 20 });
  // Failed sign-ins are throttled per IP, so guessing tokens is slow and cheap to reject.
  const authFailures = new TokenBucket({ capacity: config.authFailureLimit?.capacity ?? 20, refillPerSec: config.authFailureLimit?.refillPerSec ?? 0.5 });
  const rateLimited = registry.counter('rate_limited_total', 'Requests rejected by the per-session rate limiter');
  const degradedSections = registry.counter('home_sections_degraded_total', 'Home sections dropped because their data failed');
  const demoLogin = config.demoLogin ?? true;
  // Deals and categories are the same for every user, so the gateway caches them briefly.
  const dealsCache = new TtlCache<ProductSummary[]>({ ttlMs: 30_000 });
  const categoriesCache = new TtlCache<Category[]>({ ttlMs: 30_000 });

  const auth: Middleware = async (req, next) => {
    if (PUBLIC_ROUTES.has(req.route)) {
      req.state.rateKey = `ip:${req.ip}`;
      return next();
    }
    const token = bearer(req);
    const session = token ? sessions.resolve(token) : null;
    if (!session) {
      const throttle = authFailures.take(`ip:${req.ip}`);
      if (!throttle.ok) {
        rateLimited.inc({ route: 'auth_failure' });
        throw new HttpError(429, 'rate_limited', 'Too many failed sign-in attempts; try again later', undefined, { 'retry-after': String(throttle.retryAfterSec) });
      }
      throw new HttpError(401, 'unauthorized', 'Sign in to continue', undefined, { 'www-authenticate': 'Bearer' });
    }
    req.state.userId = session.user.id;
    req.state.user = session.user;
    req.state.rateKey = `s:${session.key}`;
    return next();
  };

  const rateLimit: Middleware = async (req, next) => {
    const taken = limiter.take(String(req.state.rateKey));
    if (!taken.ok) {
      rateLimited.inc({ route: req.route });
      throw new HttpError(429, 'rate_limited', 'Too many requests; slow down', undefined, { 'retry-after': String(taken.retryAfterSec) });
    }
    return next();
  };

  const forward =
    (target: Upstream, method: string, path: (req: Request) => string, timeoutMs?: number): Handler =>
    async (req) => {
      const res = await target.request(method, path(req), {
        userId: req.state.userId,
        requestId: req.requestId,
        body: req.body,
        query: req.query.toString(),
        idempotencyKey: req.header('idempotency-key'),
        timeoutMs,
      });
      const headers: Record<string, string> = {};
      for (const name of PASS_THROUGH_HEADERS) {
        const value = res.headers.get(name);
        if (value) headers[name] = value;
      }
      return { status: res.status, body: res.body, headers };
    };
  const enc = encodeURIComponent;

  const router = new Router();

  router.get('/v1/auth/demo-users', async (req) => {
    if (!demoLogin) throw new HttpError(404, 'not_found', 'Demo sign-in is disabled');
    return forward(orders, 'GET', () => '/internal/users')(req);
  });
  router.post('/v1/auth/demo-login', async (req) => {
    if (!demoLogin) throw new HttpError(404, 'not_found', 'Demo sign-in is disabled');
    const { userId } = parseBody<{ userId: string }>(LOGIN_SCHEMA, req.body);
    const user = await orders.json<User>('GET', `/internal/users/${enc(userId)}`, { requestId: req.requestId });
    return { status: 201, body: { token: sessions.create(user), user } };
  });
  // Idempotent: revoking an unknown or already revoked token still succeeds, so retries are safe.
  router.post('/v1/auth/logout', (req) => {
    const token = bearer(req);
    if (token) sessions.revoke(token);
    return { body: { ok: true } };
  });

  router.get('/v1/me', forward(orders, 'GET', () => '/v1/me'));

  router.get('/v1/home', async (req) => {
    const user = req.state.user as User;
    const call = { userId: user.id, requestId: req.requestId };
    const fetchers: HomeFetchers = {
      budgets: async () => (await orders.json<{ items: Budget[] }>('GET', '/v1/budgets', call)).items,
      approvals: async () => ({ total: (await orders.json<Paged<OrderSummary>>('GET', '/v1/approvals', call)).total }),
      buyAgain: async () => {
        const { items } = await orders.json<{ items: BuyAgainItem[] }>('GET', '/v1/buy-again', { ...call, query: 'limit=8' });
        if (items.length === 0) return [];
        const found = await catalog.json<SearchResult>('GET', '/v1/products', { ...call, query: `skus=${items.map((i) => enc(i.sku)).join(',')}` });
        const lastQty = new Map(items.map((i) => [i.sku, i.lastQty]));
        return found.items.map((p) => ({ ...p, suggestedQty: lastQty.get(p.sku) ?? 1 }));
      },
      deals: () => dealsCache.get(async () => (await catalog.json<{ items: ProductSummary[] }>('GET', '/v1/deals', { ...call, query: 'limit=8' })).items),
      categories: () => categoriesCache.get(async () => (await catalog.json<{ items: Category[] }>('GET', '/v1/categories', call)).items),
      recentOrders: async () =>
        (await orders.json<Paged<OrderSummary>>('GET', '/v1/orders', { ...call, query: `limit=3&scope=${user.role === 'REQUESTER' ? 'mine' : 'team'}` })).items,
    };
    const home = await composeHome({
      user,
      layout,
      flags,
      fetchers,
      capabilities: parseCapabilities(req.header('x-sdui-capabilities')),
      timeoutMs: config.homeSectionTimeoutMs ?? 1_500,
    });
    for (const id of home.degraded) degradedSections.inc({ section: id });
    if (home.degraded.length > 0) logger.warn('home_degraded', { reqId: req.requestId, sections: home.degraded });
    return { body: home };
  });

  router.get('/v1/products', forward(catalog, 'GET', () => '/v1/products'));
  router.get('/v1/products/:sku', forward(catalog, 'GET', (r) => `/v1/products/${enc(r.params.sku!)}`));
  router.get('/v1/categories', forward(catalog, 'GET', () => '/v1/categories'));
  router.get('/v1/deals', forward(catalog, 'GET', () => '/v1/deals'));

  router.get('/v1/cart', forward(orders, 'GET', () => '/v1/cart'));
  router.put('/v1/cart/items/:sku', forward(orders, 'PUT', (r) => `/v1/cart/items/${enc(r.params.sku!)}`));
  router.post('/v1/cart/items', forward(orders, 'POST', () => '/v1/cart/items'));
  router.delete('/v1/cart', forward(orders, 'DELETE', () => '/v1/cart'));

  router.post('/v1/orders/preview', forward(orders, 'POST', () => '/v1/orders/preview'));
  router.post('/v1/orders', forward(orders, 'POST', () => '/v1/orders'));
  router.get('/v1/orders', forward(orders, 'GET', () => '/v1/orders'));
  router.get('/v1/orders/:id', forward(orders, 'GET', (r) => `/v1/orders/${enc(r.params.id!)}`));
  for (const action of ['approve', 'reject', 'cancel', 'reorder']) {
    router.post(`/v1/orders/:id/${action}`, forward(orders, 'POST', (r) => `/v1/orders/${enc(r.params.id!)}/${action}`));
  }
  router.get('/v1/approvals', forward(orders, 'GET', () => '/v1/approvals'));
  router.get('/v1/budgets', forward(orders, 'GET', () => '/v1/budgets'));
  router.get('/v1/buy-again', forward(orders, 'GET', () => '/v1/buy-again'));

  router.post('/v1/assistant/turns', forward(assistant, 'POST', () => '/v1/assistant/turns', 60_000));
  router.post('/v1/assistant/actions/:id/confirm', forward(assistant, 'POST', (r) => `/v1/assistant/actions/${enc(r.params.id!)}/confirm`, 30_000));
  router.post('/v1/assistant/actions/:id/cancel', forward(assistant, 'POST', (r) => `/v1/assistant/actions/${enc(r.params.id!)}/cancel`));

  const service = await startService({
    name: 'gateway',
    port: config.port,
    host: config.host,
    router,
    logger,
    metrics: registry,
    middleware: [auth, rateLimit],
    cors: config.corsOrigin === undefined ? '*' : config.corsOrigin,
    fallback: config.webDist ? staticFiles(config.webDist) : undefined,
    onClose: () => sessions.close(),
  });
  return { ...service, sessions, registry, upstreams: { catalog, orders, assistant } };
}
