import { ApiError, NetworkError, TimeoutError, isRetryableStatus } from './errors.ts';
import { newIdempotencyKey, randomId } from './random.ts';
import { backoffDelay, parseRetryAfter, sleep as defaultSleep } from './retry.ts';
import type {
  ApprovalDecision,
  AssistantTurn,
  Budget,
  BuyAgainItem,
  Cart,
  Category,
  CheckoutRequest,
  DemoUser,
  HomeScreen,
  Me,
  Order,
  OrderListParams,
  OrderPreview,
  OrderSummary,
  Paged,
  PendingAction,
  Product,
  SearchParams,
  SearchResult,
  Session,
} from './types.ts';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type RetryOptions = { retries: number; baseDelayMs: number; maxDelayMs: number; maxRetryAfterMs: number };

export type RequestInfo = {
  method: string;
  path: string;
  attempt: number;
  status: number | null;
  durationMs: number;
  requestId: string;
  error?: string;
};

export type ClientOptions = {
  baseUrl: string;
  token?: string | null | (() => string | null | undefined);
  fetch?: FetchLike;
  retry?: Partial<RetryOptions>;
  timeoutMs?: number;
  sduiCapabilities?: string[];
  onRequest?: (info: RequestInfo) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type QueryValue = string | number | boolean | undefined | null | string[];

type CallOptions = {
  body?: unknown;
  query?: Record<string, QueryValue>;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  auth?: boolean;
  // The call has no side effects or the server deduplicates it, so it is safe to retry.
  retrySafe?: boolean;
  timeoutMs?: number;
};

const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 200, maxDelayMs: 5_000, maxRetryAfterMs: 30_000 };

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'invalid_response', message: text.slice(0, 200) } };
  }
}

export class ProcurePilotClient {
  #baseUrl: string;
  #token: ClientOptions['token'];
  #fetch: FetchLike;
  #retry: RetryOptions;
  #timeoutMs: number;
  #capabilities: string[];
  #onRequest: ((info: RequestInfo) => void) | undefined;
  #sleep: (ms: number) => Promise<void>;
  #random: () => number;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    // Browsers require fetch to be called with the global object as `this` ("Illegal invocation").
    this.#fetch = options.fetch ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#capabilities = options.sduiCapabilities ?? [];
    this.#onRequest = options.onRequest;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  #currentToken(): string | null | undefined {
    return typeof this.#token === 'function' ? this.#token() : this.#token;
  }

  async request<T>(method: string, path: string, call: CallOptions = {}): Promise<T> {
    const requestId = randomId('req', 8);
    const url = `${this.#baseUrl}${path}${buildQuery(call.query)}`;
    const headers: Record<string, string> = { accept: 'application/json', 'x-request-id': requestId, ...call.headers };
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
    if (call.auth !== false) {
      const token = this.#currentToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    const safe = method === 'GET' || method === 'PUT' || method === 'DELETE' || Boolean(call.idempotencyKey) || call.retrySafe === true;
    const maxAttempts = safe ? this.#retry.retries + 1 : 1;
    const timeoutMs = call.timeoutMs ?? this.#timeoutMs;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let delayMs: number;
      try {
        const res = await this.#fetch(url, { method, headers, body, signal: controller.signal });
        const text = await res.text();
        clearTimeout(timer);
        const serverRequestId = res.headers.get('x-request-id') ?? requestId;
        this.#onRequest?.({ method, path, attempt, status: res.status, durationMs: Date.now() - started, requestId: serverRequestId });
        const data = parseBody(text);
        if (res.status >= 200 && res.status < 300) return data as T;
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const error = ApiError.fromResponse(res.status, data, serverRequestId, retryAfter);
        if (!isRetryableStatus(res.status) || attempt === maxAttempts) throw error;
        lastError = error;
        // A server-requested wait (rate limit, open circuit) wins over the normal backoff.
        delayMs =
          retryAfter !== null
            ? Math.min(retryAfter, this.#retry.maxRetryAfterMs)
            : backoffDelay(attempt - 1, this.#retry.baseDelayMs, this.#retry.maxDelayMs, this.#random);
      } catch (caught) {
        clearTimeout(timer);
        if (caught instanceof ApiError) throw caught;
        const error = controller.signal.aborted
          ? new TimeoutError(`${method} ${path} timed out after ${timeoutMs} ms`, requestId)
          : new NetworkError(`${method} ${path} failed: ${(caught as Error)?.message ?? String(caught)}`, requestId);
        this.#onRequest?.({ method, path, attempt, status: null, durationMs: Date.now() - started, requestId, error: error.name });
        if (attempt === maxAttempts) throw error;
        lastError = error;
        delayMs = backoffDelay(attempt - 1, this.#retry.baseDelayMs, this.#retry.maxDelayMs, this.#random);
      }
      await this.#sleep(delayMs);
    }
    throw lastError;
  }

  // Authentication (demo sign-in; a production app would use OIDC).
  listDemoUsers(): Promise<{ items: DemoUser[] }> {
    return this.request('GET', '/v1/auth/demo-users', { auth: false });
  }

  demoLogin(userId: string): Promise<Session> {
    return this.request('POST', '/v1/auth/demo-login', { auth: false, body: { userId } });
  }

  logout(): Promise<{ ok: true }> {
    return this.request('POST', '/v1/auth/logout', { retrySafe: true });
  }

  me(): Promise<Me> {
    return this.request('GET', '/v1/me');
  }

  home(): Promise<HomeScreen> {
    const headers: Record<string, string> = {};
    if (this.#capabilities.length > 0) headers['x-sdui-capabilities'] = this.#capabilities.join(',');
    return this.request('GET', '/v1/home', { headers });
  }

  // Catalog
  searchProducts(params: SearchParams = {}): Promise<SearchResult> {
    return this.request('GET', '/v1/products', {
      query: {
        q: params.q,
        category: params.category,
        gstInvoice: params.gstInvoice ? 'true' : undefined,
        maxUnitPrice: params.maxUnitPrice,
        sort: params.sort,
        limit: params.limit,
        cursor: params.cursor,
        skus: params.skus,
      },
    });
  }

  getProduct(sku: string): Promise<Product> {
    return this.request('GET', `/v1/products/${encodeURIComponent(sku)}`);
  }

  listCategories(): Promise<{ items: Category[] }> {
    return this.request('GET', '/v1/categories');
  }

  // Cart
  getCart(): Promise<Cart> {
    return this.request('GET', '/v1/cart');
  }

  setCartItem(sku: string, qty: number): Promise<Cart> {
    return this.request('PUT', `/v1/cart/items/${encodeURIComponent(sku)}`, { body: { qty } });
  }

  addToCart(sku: string, qty: number, options: { idempotencyKey?: string } = {}): Promise<Cart> {
    return this.request('POST', '/v1/cart/items', { body: { sku, qty }, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() });
  }

  clearCart(): Promise<Cart> {
    return this.request('DELETE', '/v1/cart');
  }

  // Orders and approvals
  previewOrder(costCenterId: string): Promise<OrderPreview> {
    return this.request('POST', '/v1/orders/preview', { body: { costCenterId }, retrySafe: true });
  }

  // Pass the same idempotencyKey when replaying a checkout; the server returns the original order.
  checkout(request: CheckoutRequest, options: { idempotencyKey?: string } = {}): Promise<Order> {
    return this.request('POST', '/v1/orders', { body: request, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() });
  }

  listOrders(params: OrderListParams = {}): Promise<Paged<OrderSummary>> {
    return this.request('GET', '/v1/orders', { query: { status: params.status, scope: params.scope, limit: params.limit, offset: params.offset } });
  }

  getOrder(id: string): Promise<Order> {
    return this.request('GET', `/v1/orders/${encodeURIComponent(id)}`);
  }

  approveOrder(id: string, decision: ApprovalDecision): Promise<Order> {
    return this.request('POST', `/v1/orders/${encodeURIComponent(id)}/approve`, { body: decision, idempotencyKey: newIdempotencyKey() });
  }

  rejectOrder(id: string, decision: ApprovalDecision): Promise<Order> {
    return this.request('POST', `/v1/orders/${encodeURIComponent(id)}/reject`, { body: decision, idempotencyKey: newIdempotencyKey() });
  }

  cancelOrder(id: string, version: number): Promise<Order> {
    return this.request('POST', `/v1/orders/${encodeURIComponent(id)}/cancel`, { body: { version }, idempotencyKey: newIdempotencyKey() });
  }

  reorder(id: string, options: { idempotencyKey?: string } = {}): Promise<Cart> {
    return this.request('POST', `/v1/orders/${encodeURIComponent(id)}/reorder`, { idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() });
  }

  listApprovals(): Promise<Paged<OrderSummary>> {
    return this.request('GET', '/v1/approvals');
  }

  listBudgets(): Promise<{ items: Budget[] }> {
    return this.request('GET', '/v1/budgets');
  }

  buyAgain(): Promise<{ items: BuyAgainItem[] }> {
    return this.request('GET', '/v1/buy-again');
  }

  // Assistant
  askAssistant(message: string, conversationId?: string): Promise<AssistantTurn> {
    return this.request('POST', '/v1/assistant/turns', { body: { message, conversationId }, timeoutMs: 60_000 });
  }

  confirmAction(id: string): Promise<PendingAction> {
    return this.request('POST', `/v1/assistant/actions/${encodeURIComponent(id)}/confirm`, { retrySafe: true, timeoutMs: 30_000 });
  }

  cancelAction(id: string): Promise<PendingAction> {
    return this.request('POST', `/v1/assistant/actions/${encodeURIComponent(id)}/cancel`, { retrySafe: true });
  }
}

export function createClient(options: ClientOptions): ProcurePilotClient {
  return new ProcurePilotClient(options);
}
