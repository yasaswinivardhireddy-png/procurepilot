import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from './log.ts';
import type { Registry } from './metrics.ts';

export class HttpError extends Error {
  name = 'HttpError';
  status: number;
  code: string;
  details: unknown;
  headers: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: unknown, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export type RequestState = { userId?: string; [key: string]: unknown };

export type Request = {
  method: string;
  path: string;
  route: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  requestId: string;
  ip: string;
  state: RequestState;
  header(name: string): string | undefined;
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
export type Handler = (req: Request) => Reply | Promise<Reply>;
export type Middleware = (req: Request, next: () => Promise<Reply>) => Promise<Reply>;

type Route = { method: string; pattern: string; regex: RegExp; keys: string[]; handler: Handler };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) return escapeRegex(segment);
        keys.push(segment.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.#routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed: string[] = [];
    for (const route of this.#routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      try {
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(m[i + 1]!);
        });
      } catch {
        throw new HttpError(400, 'invalid_path', 'Malformed URL path');
      }
      return { route, params };
    }
    return allowed.length > 0 ? { allowed } : null;
  }
}

export type ServiceOptions = {
  name: string;
  port: number;
  host?: string;
  router: Router;
  logger: Logger;
  metrics: Registry;
  middleware?: Middleware[];
  cors?: string | null;
  bodyLimitBytes?: number;
  // Serves non-API GET requests (for example the web build of the app). Returns true when handled.
  fallback?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
  onClose?: () => void | Promise<void>;
};

export type RunningService = { name: string; url: string; port: number; close(): Promise<void> };

const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'internal_error', 'Internal server error');
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
  const payload = body === undefined || status === 204 ? undefined : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...headers,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    req.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`, undefined, { connection: 'close' });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

function runChain(middleware: Middleware[], handler: Handler, req: Request): Promise<Reply> {
  const dispatch = async (i: number): Promise<Reply> => (i < middleware.length ? middleware[i]!(req, () => dispatch(i + 1)) : handler(req));
  return dispatch(0);
}

export async function startService(opts: ServiceOptions): Promise<RunningService> {
  const { router, logger, metrics } = opts;
  const requests = metrics.counter('http_requests_total', 'HTTP requests by route and status');
  const duration = metrics.histogram('http_request_duration_seconds', 'HTTP request latency in seconds');
  const inflightGauge = metrics.gauge('http_requests_in_flight', 'Requests currently being processed');
  const middleware = opts.middleware ?? [];
  const bodyLimit = opts.bodyLimitBytes ?? 256 * 1024;
  const startedAt = Date.now();
  let inFlight = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const method = req.method ?? 'GET';
    const incomingId = req.headers['x-request-id'];
    const requestId = typeof incomingId === 'string' && REQUEST_ID_RE.test(incomingId) ? incomingId : randomUUID();
    const state: RequestState = {};
    let path = '/';
    let route = 'unmatched';
    let status = 500;
    inflightGauge.set({}, ++inFlight);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      path = url.pathname;
      if (opts.cors) {
        res.setHeader('access-control-allow-origin', opts.cors);
        res.setHeader('access-control-expose-headers', 'x-request-id, retry-after, idempotent-replayed');
      }
      if (method === 'OPTIONS' && opts.cors) {
        route = 'preflight';
        status = 204;
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-request-id, x-sdui-capabilities',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }
      if (method === 'GET' && path === '/healthz') {
        route = '/healthz';
        status = 200;
        sendJson(res, 200, { status: 'ok', service: opts.name, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }, requestId);
        return;
      }
      if (method === 'GET' && path === '/metrics') {
        route = '/metrics';
        status = 200;
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(metrics.render());
        return;
      }
      const match = router.match(method, path);
      if (!match) {
        if (opts.fallback && (method === 'GET' || method === 'HEAD') && (await opts.fallback(req, res, path))) {
          route = 'static';
          status = res.statusCode;
          return;
        }
        throw new HttpError(404, 'not_found', `No route for ${method} ${path}`);
      }
      if ('allowed' in match) {
        throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${path}`, undefined, { allow: match.allowed.join(', ') });
      }
      route = match.route.pattern;
      const body = await readBody(req, bodyLimit);
      const request: Request = {
        method,
        path,
        route,
        params: match.params,
        query: url.searchParams,
        headers: req.headers,
        body,
        requestId,
        ip: req.socket.remoteAddress ?? 'unknown',
        state,
        header: (name) => {
          const value = req.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
      };
      const reply = await runChain(middleware, match.route.handler, request);
      status = reply.status ?? 200;
      sendJson(res, status, reply.body, requestId, reply.headers);
    } catch (error) {
      const httpError = toHttpError(error);
      status = httpError.status;
      if (!(error instanceof HttpError)) {
        logger.error('unhandled_error', { reqId: requestId, route, error: (error as Error)?.stack ?? String(error) });
      }
      if (res.headersSent) {
        res.destroy();
      } else {
        const body = { error: { code: httpError.code, message: httpError.message, details: httpError.details, requestId } };
        sendJson(res, status, body, requestId, httpError.headers);
      }
    } finally {
      inflightGauge.set({}, --inFlight);
      const seconds = (performance.now() - started) / 1000;
      requests.inc({ method, route, status: String(status) });
      duration.observe({ method, route }, seconds);
      if (route !== '/healthz' && route !== '/metrics') {
        logger.info('request', { reqId: requestId, method, route, status, durMs: Math.round(seconds * 100_000) / 100, userId: state.userId });
      }
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  logger.info('listening', { url });

  return {
    name: opts.name,
    url,
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await opts.onClose?.();
    },
  };
}

export function intParam(query: URLSearchParams, name: string, options: { min: number; max: number; fallback: number }): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return options.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw new HttpError(400, 'invalid_query', `${name} must be an integer between ${options.min} and ${options.max}`);
  }
  return value;
}
