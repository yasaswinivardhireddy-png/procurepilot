import type { CartItemInput, ProductSort } from '../../../sdk/src/types.ts';
import { HttpError, Router, intParam, startService, type RunningService } from '../shared/http.ts';
import { internalAuth } from '../shared/internal-auth.ts';
import { createLogger, type LogLevel } from '../shared/log.ts';
import { Registry } from '../shared/metrics.ts';
import { parseBody, type Schema } from '../shared/validate.ts';
import { CATEGORIES, PRODUCTS, type CatalogProduct } from './data.ts';
import { priceQuote, toProduct, toSummary } from './pricing.ts';
import { SearchIndex } from './search.ts';

export type CatalogConfig = { port: number; host?: string; internalToken: string; logLevel?: LogLevel; products?: CatalogProduct[] };

const SORTS: ProductSort[] = ['relevance', 'price_asc', 'price_desc', 'delivery', 'rating'];

const QUOTE_SCHEMA: Schema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['sku', 'qty'],
        additionalProperties: false,
        properties: { sku: { type: 'string', minLength: 1, maxLength: 40 }, qty: { type: 'integer', minimum: 1, maximum: 10_000 } },
      },
    },
  },
};

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const offset = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Invalid pagination cursor');
}

export function createCatalogRouter(products: CatalogProduct[]): Router {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const index = new SearchIndex(products);
  const router = new Router();

  router.get('/v1/products', (req) => {
    const q = req.query;
    const limit = intParam(q, 'limit', { min: 1, max: 50, fallback: 20 });
    const skus = q.get('skus');
    if (skus) {
      const items = skus
        .split(',')
        .slice(0, 50)
        .map((sku) => bySku.get(sku.trim()))
        .filter((p): p is CatalogProduct => p !== undefined)
        .map(toSummary);
      return { body: { items, total: items.length, nextCursor: null } };
    }
    const text = (q.get('q') ?? '').trim().slice(0, 120);
    const sort = (q.get('sort') ?? 'relevance') as ProductSort;
    if (!SORTS.includes(sort)) throw new HttpError(400, 'invalid_query', `sort must be one of ${SORTS.join(', ')}`);
    const category = q.get('category');
    const gstOnly = q.get('gstInvoice') === 'true';
    const maxUnitPrice = q.has('maxUnitPrice') ? intParam(q, 'maxUnitPrice', { min: 0, max: 1_000_000_000, fallback: 0 }) : null;

    let candidates = text
      ? index.search(text).map((r) => r.product)
      : [...products].sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title));
    candidates = candidates.filter(
      (p) => (!category || p.category === category) && (!gstOnly || p.gstInvoice) && (maxUnitPrice === null || p.unitPrice <= maxUnitPrice),
    );
    if (sort === 'price_asc') candidates.sort((a, b) => a.unitPrice - b.unitPrice);
    if (sort === 'price_desc') candidates.sort((a, b) => b.unitPrice - a.unitPrice);
    if (sort === 'delivery') candidates.sort((a, b) => a.deliveryDays - b.deliveryDays);
    if (sort === 'rating') candidates.sort((a, b) => b.rating - a.rating);

    const offset = decodeCursor(q.get('cursor'));
    const page = candidates.slice(offset, offset + limit);
    const nextCursor = offset + limit < candidates.length ? encodeCursor(offset + limit) : null;
    return { body: { items: page.map(toSummary), total: candidates.length, nextCursor } };
  });

  router.get('/v1/products/:sku', (req) => {
    const product = bySku.get(req.params.sku!);
    if (!product) throw new HttpError(404, 'product_not_found', `No product with SKU ${req.params.sku}`);
    return { body: toProduct(product) };
  });

  router.get('/v1/categories', () => {
    const items = Object.values(CATEGORIES).map((name) => ({ name, count: products.filter((p) => p.category === name).length }));
    return { body: { items: items.filter((c) => c.count > 0) } };
  });

  // Products with the deepest volume discounts, for the "bulk-buy savings" home section.
  router.get('/v1/deals', (req) => {
    const limit = intParam(req.query, 'limit', { min: 1, max: 20, fallback: 8 });
    const items = products
      .filter((p) => p.stock > 0)
      .map(toSummary)
      .sort((a, b) => b.bestTierDiscountBps - a.bestTierDiscountBps || b.rating - a.rating)
      .slice(0, limit);
    return { body: { items } };
  });

  router.post('/v1/quotes', (req) => {
    const { items } = parseBody<{ items: CartItemInput[] }>(QUOTE_SCHEMA, req.body);
    return { body: priceQuote((sku) => bySku.get(sku), items) };
  });

  return router;
}

export async function startCatalogService(config: CatalogConfig): Promise<RunningService> {
  const logger = createLogger('catalog', config.logLevel);
  return startService({
    name: 'catalog',
    port: config.port,
    host: config.host,
    router: createCatalogRouter(config.products ?? PRODUCTS),
    logger,
    metrics: new Registry(),
    middleware: [internalAuth(config.internalToken)],
  });
}
