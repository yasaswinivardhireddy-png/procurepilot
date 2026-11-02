import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRODUCTS } from '../server/src/catalog/data.ts';
import { priceQuote, priceTiers, unitPriceAt } from '../server/src/catalog/pricing.ts';
import { SearchIndex, tokenize } from '../server/src/catalog/search.ts';
import { createCatalogRouter } from '../server/src/catalog/service.ts';

const bySku = new Map(PRODUCTS.map((p) => [p.sku, p]));
const paper = bySku.get('OFF-A4-JK75')!;

describe('pricing', () => {
  it('applies the highest volume tier reached', () => {
    assert.equal(unitPriceAt(paper, 9), 29_900);
    assert.equal(unitPriceAt(paper, 10), 28_405);
    assert.equal(unitPriceAt(paper, 50), 26_312);
    assert.deepEqual(
      priceTiers(paper).map((t) => [t.minQty, t.unitPrice]),
      [
        [1, 29_900],
        [10, 28_405],
        [50, 26_312],
      ],
    );
  });

  it('prices a quote with GST, savings, stock and unknown SKUs', () => {
    const quote = priceQuote((sku) => bySku.get(sku), [
      { sku: 'OFF-A4-JK75', qty: 20 },
      { sku: 'FUR-DSK-FL120', qty: 26 },
      { sku: 'NOPE', qty: 1 },
    ]);
    const [paperLine, deskLine] = quote.lines;
    assert.equal(paperLine!.lineSubtotal, 568_100);
    assert.equal(paperLine!.gst, 68_172); // 12%
    assert.equal(paperLine!.lineTotal, 636_272);
    assert.equal(deskLine!.available, false); // only 25 in stock
    assert.deepEqual(quote.unknownSkus, ['NOPE']);
    assert.equal(quote.total, quote.subtotal + quote.gst);
    assert.equal(quote.savings, (29_900 - 28_405) * 20 + (2_850_000 - 2_593_500) * 26);
  });
});

describe('search', () => {
  const index = new SearchIndex(PRODUCTS);

  it('normalizes plurals, punctuation, stop words and irregular plurals', () => {
    assert.deepEqual(tokenize('Boxes of Pens, A4-Paper!'), ['pen', 'a4', 'paper']);
    assert.deepEqual(tokenize('Wireless Mice'), ['wireless', 'mouse']);
  });

  it('ranks title matches above incidental matches', () => {
    const results = index.search('a4 paper').map((r) => r.product.sku);
    assert.deepEqual(results.slice(0, 3).sort(), ['OFF-A4-DA80', 'OFF-A4-JK70', 'OFF-A4-JK75']);
  });

  it('expands the last term as a prefix for search-as-you-type', () => {
    assert.equal(index.search('ergonomic cha')[0]!.product.sku, 'FUR-CHR-GSSEOUL');
    assert.equal(index.search('stapl')[0]!.product.sku, 'OFF-STP-KAN');
  });

  it('returns nothing for unrelated text', () => {
    assert.deepEqual(index.search('zzzz qqqq'), []);
  });
});

describe('catalog API', () => {
  const router = createCatalogRouter(PRODUCTS);
  const get = async (path: string) => {
    const url = new URL(path, 'http://x');
    const match = router.match('GET', url.pathname);
    assert.ok(match && 'route' in match);
    const reply = await match.route.handler({
      method: 'GET',
      path: url.pathname,
      route: match.route.pattern,
      params: match.params,
      query: url.searchParams,
      headers: {},
      body: undefined,
      requestId: 'test',
      ip: '127.0.0.1',
      state: {},
      header: () => undefined,
    });
    return reply.body as { items: { sku: string; unitPrice: number; gstInvoice: boolean }[]; total: number; nextCursor: string | null };
  };

  it('filters by GST invoice and price, and sorts by price', async () => {
    const page = await get('/v1/products?q=pens&gstInvoice=true&sort=price_asc');
    assert.ok(page.items.every((p) => p.gstInvoice));
    assert.ok(!page.items.some((p) => p.sku === 'OFF-PEN-CEL25'));
    const cheap = await get('/v1/products?maxUnitPrice=30000&sort=price_asc');
    assert.ok(cheap.items.every((p) => p.unitPrice <= 30_000));
    assert.deepEqual(cheap.items.map((p) => p.unitPrice), [...cheap.items.map((p) => p.unitPrice)].sort((a, b) => a - b));
  });

  it('paginates with an opaque cursor', async () => {
    const first = await get('/v1/products?limit=10');
    const second = await get(`/v1/products?limit=10&cursor=${first.nextCursor}`);
    assert.equal(first.total, PRODUCTS.length);
    assert.equal(new Set([...first.items, ...second.items].map((p) => p.sku)).size, 20);
  });
});
