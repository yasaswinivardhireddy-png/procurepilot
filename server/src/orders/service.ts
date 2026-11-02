import { fileURLToPath } from 'node:url';
import type { Cart, CartItemInput, CheckoutRequest, OrderPreview, OrderStatus, Quote, User } from '../../../sdk/src/types.ts';
import { transaction } from '../shared/db.ts';
import { faultInjection, type FaultConfig } from '../shared/faults.ts';
import { HttpError, Router, intParam, startService, type Middleware, type Reply, type Request, type RunningService } from '../shared/http.ts';
import { sha256, stableStringify } from '../shared/ids.ts';
import { internalAuth, requireUserId } from '../shared/internal-auth.ts';
import { createLogger, type LogLevel } from '../shared/log.ts';
import { Registry, type Counter } from '../shared/metrics.ts';
import { Upstream } from '../shared/resilience.ts';
import { parseBody, type Schema } from '../shared/validate.ts';
import { PolicyStore, escalateUnapprovable, evaluatePolicy, type ApprovalPolicy } from './policy.ts';
import { OrdersStore, type OrderScope } from './store.ts';
import { canView, isCompanyWide, transition, type Actor, type WorkflowCommand } from './workflow.ts';

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../config/approval-policy.json', import.meta.url));

export type OrdersConfig = {
  port: number;
  host?: string;
  internalToken: string;
  dbPath: string;
  catalogUrl: string;
  policyPath?: string;
  watchPolicy?: boolean;
  logLevel?: LogLevel;
  faults?: FaultConfig;
  loadTestUsers?: number;
};

export type OrdersService = RunningService & { store: OrdersStore; policies: PolicyStore; registry: Registry };

const SKU = { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Z0-9-]+$' } as const;
const ITEM_SCHEMA: Schema = {
  type: 'object',
  required: ['sku', 'qty'],
  additionalProperties: false,
  properties: { sku: SKU, qty: { type: 'integer', minimum: 1, maximum: 10_000 } },
};
const SET_QTY_SCHEMA: Schema = {
  type: 'object',
  required: ['qty'],
  additionalProperties: false,
  properties: { qty: { type: 'integer', minimum: 0, maximum: 10_000 } },
};
const COST_CENTER = { type: 'string', pattern: '^cc_[a-z0-9_]{1,30}$' } as const;
const CHECKOUT_SCHEMA: Schema = {
  type: 'object',
  required: ['costCenterId'],
  additionalProperties: false,
  properties: {
    costCenterId: COST_CENTER,
    poNumber: { type: 'string', maxLength: 40, pattern: '^[A-Za-z0-9 /_-]*$' },
    note: { type: 'string', maxLength: 280 },
    expectedItems: { type: 'array', maxItems: 100, items: ITEM_SCHEMA },
    expectedTotal: { type: 'integer', minimum: 0 },
    expectedPolicyVersion: { type: 'integer', minimum: 1 },
  },
};
const PREVIEW_SCHEMA: Schema = { type: 'object', required: ['costCenterId'], additionalProperties: false, properties: { costCenterId: COST_CENTER } };
const DECISION_SCHEMA: Schema = {
  type: 'object',
  required: ['version'],
  additionalProperties: false,
  properties: { version: { type: 'integer', minimum: 1 }, comment: { type: 'string', maxLength: 280 } },
};

const STATUSES: OrderStatus[] = ['PENDING_APPROVAL', 'PLACED', 'REJECTED', 'CANCELLED'];
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;
const EMPTY_CART: Cart = { lines: [], subtotal: 0, gst: 0, total: 0, savings: 0, unknownSkus: [], itemCount: 0 };
const REPLAYED: Record<string, string> = { 'idempotent-replayed': 'true' };

function sameItems(a: CartItemInput[], b: CartItemInput[]): boolean {
  if (a.length !== b.length) return false;
  const quantities = new Map(a.map((i) => [i.sku, i.qty]));
  return b.every((i) => quantities.get(i.sku) === i.qty);
}

function idempotencyKeyOf(req: Request, required: boolean): string | null {
  const key = req.header('idempotency-key');
  if (!key) {
    if (required) throw new HttpError(400, 'idempotency_key_required', 'Send an Idempotency-Key header with this request');
    return null;
  }
  if (!KEY_RE.test(key)) throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-128 characters from [A-Za-z0-9_-:.]');
  return key;
}

const requestHash = (req: Request): string => sha256(`${req.method} ${req.path}\n${stableStringify(req.body ?? null)}`);

type Deps = { store: OrdersStore; policies: PolicyStore; catalog: Upstream; ordersCreated: Counter; replays: Counter };

export function createOrdersRouter({ store, policies, catalog, ordersCreated, replays }: Deps): Router {
  const router = new Router();

  const currentUser = (req: Request): User => {
    const user = store.getUser(requireUserId(req));
    if (!user) throw new HttpError(401, 'unknown_user', 'Unknown user');
    return user;
  };

  const actorOf = (user: User): Actor => ({ id: user.id, name: user.name, role: user.role, costCenterIds: user.costCenterIds });

  // Returns the stored response when this key was already used for the same request.
  const replay = (req: Request, userId: string, key: string | null): Reply | null => {
    if (!key) return null;
    const prior = store.findIdempotent(userId, key);
    if (!prior) return null;
    if (prior.requestHash !== requestHash(req)) {
      throw new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    }
    replays.inc({ route: req.route });
    return { status: prior.status, body: JSON.parse(prior.body), headers: REPLAYED };
  };

  // Checkout also falls back to the order row itself, which outlives the purged idempotency records.
  const replayCheckout = (req: Request, userId: string, key: string): Reply | null => {
    const stored = replay(req, userId, key);
    if (stored) return stored;
    const order = store.orderByIdempotencyKey(userId, key);
    if (!order) return null;
    if (order.requestHash !== requestHash(req)) {
      throw new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    }
    replays.inc({ route: req.route });
    return { status: 201, body: store.getOrder(order.id), headers: REPLAYED };
  };

  // The policy's approval chain, with steps nobody else could approve escalated.
  const routeApprovals = (policy: ApprovalPolicy, priced: Quote, available: number, costCenterId: string, requesterId: string) =>
    escalateUnapprovable(
      policy,
      evaluatePolicy(policy, { total: priced.total, available, lines: priced.lines.map((l) => ({ category: l.category, qty: l.qty, lineTotal: l.lineTotal })) }),
      (role) => store.hasEligibleApprover(role, costCenterId, requesterId),
    );

  const quote = (items: CartItemInput[], requestId: string): Promise<Quote> =>
    catalog.json<Quote>('POST', '/v1/quotes', { body: { items }, requestId });

  const pricedCart = async (userId: string, requestId: string): Promise<Cart> => {
    const items = store.cartItems(userId);
    if (items.length === 0) return EMPTY_CART;
    const priced = await quote(items, requestId);
    return { ...priced, itemCount: priced.lines.length };
  };

  const ensureProduct = (sku: string, requestId: string) => catalog.json('GET', `/v1/products/${encodeURIComponent(sku)}`, { requestId });

  // Internal endpoints used by the gateway and by tests.
  router.get('/internal/users', () => ({ body: { items: store.listUsers() } }));
  router.get('/internal/users/:id', (req) => {
    const user = store.getUser(req.params.id!);
    if (!user) throw new HttpError(404, 'unknown_user', 'Unknown user');
    return { body: user };
  });
  router.get('/internal/audit', () => ({ body: store.audit() }));

  router.get('/v1/me', (req) => {
    const user = currentUser(req);
    return { body: { ...user, budgets: store.budgetsFor(user) } };
  });

  router.get('/v1/budgets', (req) => ({ body: { items: store.budgetsFor(currentUser(req)) } }));

  router.get('/v1/cart', async (req) => ({ body: await pricedCart(currentUser(req).id, req.requestId) }));

  router.put('/v1/cart/items/:sku', async (req) => {
    const user = currentUser(req);
    const { qty } = parseBody<{ qty: number }>(SET_QTY_SCHEMA, req.body);
    if (qty > 0) await ensureProduct(req.params.sku!, req.requestId);
    store.setCartItem(user.id, req.params.sku!, qty);
    return { body: await pricedCart(user.id, req.requestId) };
  });

  // Adds to the existing quantity, so it is not naturally idempotent. With an Idempotency-Key the
  // increment is applied exactly once; the response is always the current cart.
  router.post('/v1/cart/items', async (req) => {
    const user = currentUser(req);
    const item = parseBody<CartItemInput>(ITEM_SCHEMA, req.body);
    const key = idempotencyKeyOf(req, false);
    const done = replay(req, user.id, key);
    if (!done) {
      await ensureProduct(item.sku, req.requestId);
      transaction(store.db, () => {
        if (replay(req, user.id, key)) return;
        store.addCartItem(user.id, item.sku, item.qty);
        if (key) store.saveIdempotent(user.id, key, requestHash(req), 200, { added: item });
      });
    }
    return { body: await pricedCart(user.id, req.requestId), headers: done ? REPLAYED : undefined };
  });

  router.delete('/v1/cart', (req) => {
    store.clearCart(currentUser(req).id);
    return { body: EMPTY_CART };
  });

  router.post('/v1/orders/preview', async (req) => {
    const user = currentUser(req);
    const { costCenterId } = parseBody<{ costCenterId: string }>(PREVIEW_SCHEMA, req.body);
    if (!user.costCenterIds.includes(costCenterId)) throw new HttpError(403, 'cost_center_forbidden', 'You cannot order on this cost center');
    const items = store.cartItems(user.id);
    if (items.length === 0) throw new HttpError(409, 'cart_empty', 'Your cart is empty');
    const priced = await quote(items, req.requestId);
    const budget = store.costCenter(costCenterId)!;
    const policy = policies.current();
    const requiredApprovals = routeApprovals(policy, priced, budget.available, costCenterId, user.id);
    const preview: OrderPreview = { quote: priced, costCenterId, available: budget.available, requiredApprovals, policyVersion: policy.version };
    return { body: preview };
  });

  router.post('/v1/orders', async (req) => {
    const user = currentUser(req);
    const body = parseBody<CheckoutRequest>(CHECKOUT_SCHEMA, req.body);
    const key = idempotencyKeyOf(req, true)!;
    const prior = replayCheckout(req, user.id, key);
    if (prior) return prior;
    if (!user.costCenterIds.includes(body.costCenterId)) throw new HttpError(403, 'cost_center_forbidden', 'You cannot order on this cost center');
    const items = store.cartItems(user.id);
    if (items.length === 0) throw new HttpError(409, 'cart_empty', 'Your cart is empty');
    if (body.expectedItems && !sameItems(items, body.expectedItems)) {
      throw new HttpError(409, 'cart_changed', 'Your cart changed since you reviewed it; review it and try again');
    }
    const priced = await quote(items, req.requestId);
    const unavailable = priced.lines.filter((l) => !l.available).map((l) => l.sku);
    if (priced.unknownSkus.length > 0 || unavailable.length > 0) {
      throw new HttpError(409, 'items_unavailable', 'Some items are unavailable in the requested quantity', { unknownSkus: priced.unknownSkus, unavailable });
    }
    if (body.expectedTotal !== undefined && priced.total !== body.expectedTotal) {
      throw new HttpError(409, 'price_changed', 'Prices changed since you reviewed your cart; review the new total', { expectedTotal: body.expectedTotal, total: priced.total });
    }

    // Budget, policy and the write happen in one transaction, so concurrent checkouts on the same
    // cost center see each other's reservations.
    return transaction(store.db, () => {
      const again = replayCheckout(req, user.id, key);
      if (again) return again;
      if (!sameItems(store.cartItems(user.id), items)) {
        throw new HttpError(409, 'cart_changed', 'Your cart changed during checkout; review it and try again');
      }
      const budget = store.costCenter(body.costCenterId)!;
      const policy = policies.current();
      if (body.expectedPolicyVersion !== undefined && policy.version !== body.expectedPolicyVersion) {
        throw new HttpError(409, 'policy_changed', 'The approval policy changed since you reviewed this order; review it again');
      }
      const order = store.createOrder({
        user,
        costCenterId: body.costCenterId,
        poNumber: body.poNumber?.trim() || null,
        note: body.note?.trim() || null,
        quote: priced,
        approvals: routeApprovals(policy, priced, budget.available, body.costCenterId, user.id),
        policyVersion: policy.version,
        idempotencyKey: key,
        requestHash: requestHash(req),
      });
      store.clearCart(user.id);
      store.saveIdempotent(user.id, key, requestHash(req), 201, order);
      ordersCreated.inc({ status: order.status });
      return { status: 201, body: order };
    });
  });

  router.get('/v1/orders', (req) => {
    const user = currentUser(req);
    const status = req.query.get('status') as OrderStatus | null;
    if (status && !STATUSES.includes(status)) throw new HttpError(400, 'invalid_query', `status must be one of ${STATUSES.join(', ')}`);
    const scopeName = req.query.get('scope') ?? 'mine';
    if (scopeName !== 'mine' && scopeName !== 'team') throw new HttpError(400, 'invalid_query', 'scope must be mine or team');
    let scope: OrderScope = { kind: 'mine', userId: user.id };
    if (scopeName === 'team') {
      if (isCompanyWide(user.role)) scope = { kind: 'all' };
      else if (user.role === 'MANAGER') scope = { kind: 'team', managerId: user.id };
    }
    const limit = intParam(req.query, 'limit', { min: 1, max: 50, fallback: 20 });
    const offset = intParam(req.query, 'offset', { min: 0, max: 100_000, fallback: 0 });
    return { body: store.listOrders(scope, { status: status ?? undefined, limit, offset }) };
  });

  router.get('/v1/orders/:id', (req) => {
    const user = currentUser(req);
    const order = store.getOrder(req.params.id!);
    if (!order || !canView(actorOf(user), { userId: order.requesterId, costCenterId: order.costCenterId })) {
      throw new HttpError(404, 'order_not_found', 'Order not found');
    }
    return { body: order };
  });

  const decide = (type: WorkflowCommand['type']) => (req: Request) => {
    const user = currentUser(req);
    const { version, comment } = parseBody<{ version: number; comment?: string }>(DECISION_SCHEMA, req.body);
    const key = idempotencyKeyOf(req, false);
    const prior = replay(req, user.id, key);
    if (prior) return prior;
    return transaction(store.db, () => {
      const again = replay(req, user.id, key);
      if (again) return again;
      const order = store.workflowOrder(req.params.id!);
      const actor = actorOf(user);
      if (!order || !canView(actor, order)) throw new HttpError(404, 'order_not_found', 'Order not found');
      const command: WorkflowCommand = type === 'CANCEL' ? { type } : { type, comment };
      const next = transition(order, command, actor, version);
      store.applyTransition(order, next, actor, comment?.trim() || null);
      const updated = store.getOrder(order.id)!;
      if (key) store.saveIdempotent(user.id, key, requestHash(req), 200, updated);
      return { status: 200, body: updated };
    });
  };

  router.post('/v1/orders/:id/approve', decide('APPROVE'));
  router.post('/v1/orders/:id/reject', decide('REJECT'));
  router.post('/v1/orders/:id/cancel', decide('CANCEL'));

  router.post('/v1/orders/:id/reorder', async (req) => {
    const user = currentUser(req);
    const key = idempotencyKeyOf(req, false);
    const done = replay(req, user.id, key);
    if (!done) {
      const order = store.getOrder(req.params.id!);
      if (!order || order.requesterId !== user.id) throw new HttpError(404, 'order_not_found', 'Order not found');
      transaction(store.db, () => {
        if (replay(req, user.id, key)) return;
        for (const line of order.lines) store.addCartItem(user.id, line.sku, line.qty);
        if (key) store.saveIdempotent(user.id, key, requestHash(req), 200, { reorderedFrom: order.id });
      });
    }
    return { body: await pricedCart(user.id, req.requestId), headers: done ? REPLAYED : undefined };
  });

  router.get('/v1/approvals', (req) => {
    const items = store.pendingFor(actorOf(currentUser(req)));
    return { body: { items, total: items.length } };
  });

  router.get('/v1/buy-again', (req) => {
    const limit = intParam(req.query, 'limit', { min: 1, max: 20, fallback: 8 });
    return { body: { items: store.buyAgain(currentUser(req).id, limit) } };
  });

  return router;
}

export async function startOrdersService(config: OrdersConfig): Promise<OrdersService> {
  const logger = createLogger('orders', config.logLevel);
  const registry = new Registry();
  const store = new OrdersStore(config.dbPath, { loadTestUsers: config.loadTestUsers });
  const policies = new PolicyStore(config.policyPath ?? DEFAULT_POLICY_PATH, logger, { watch: config.watchPolicy });
  const catalog = new Upstream({ name: 'catalog', baseUrl: config.catalogUrl, internalToken: config.internalToken, registry, logger });
  const router = createOrdersRouter({
    store,
    policies,
    catalog,
    ordersCreated: registry.counter('orders_created_total', 'Orders created, by initial status'),
    replays: registry.counter('idempotent_replays_total', 'Requests answered from the idempotency store'),
  });
  const middleware: Middleware[] = [internalAuth(config.internalToken)];
  if (config.faults) middleware.push(faultInjection(config.faults, registry.counter('faults_injected_total', 'Injected faults by phase')));

  const purge = setInterval(() => store.purgeIdempotency(new Date(Date.now() - 24 * 3_600_000).toISOString()), 10 * 60_000);
  purge.unref();

  const service = await startService({
    name: 'orders',
    port: config.port,
    host: config.host,
    router,
    logger,
    metrics: registry,
    middleware,
    onClose: () => {
      clearInterval(purge);
      policies.close();
      store.close();
    },
  });
  return { ...service, store, policies, registry };
}
