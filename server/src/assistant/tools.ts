import { formatInr } from '../../../sdk/src/format.ts';
import type { Budget, Cart, Order, OrderPreview, OrderSummary, Paged, Quote, SearchResult } from '../../../sdk/src/types.ts';
import { HttpError } from '../shared/http.ts';
import type { Upstream } from '../shared/resilience.ts';
import type { ToolDeclaration } from './llm.ts';

export type ToolContext = { userId: string; requestId: string; catalog: Upstream; orders: Upstream };

export class ToolInputError extends Error {
  name = 'ToolInputError';
}

export type Proposal = { summary: string; execArgs?: Record<string, unknown> };

export type ToolSpec = ToolDeclaration & {
  mutating: boolean;
  // Read tools run immediately. Mutating tools run only after the user confirms, with an idempotency key.
  run(args: Record<string, unknown>, ctx: ToolContext, idempotencyKey?: string): Promise<unknown>;
  // Mutating tools: checks the proposal against live data and returns what the user will confirm.
  describe?(args: Record<string, unknown>, ctx: ToolContext): Promise<Proposal>;
  summarize(args: Record<string, unknown>, result: unknown): string;
};

const rupees = (paise: number) => Math.round(paise) / 100;

const headers = (ctx: ToolContext) => ({ userId: ctx.userId, requestId: ctx.requestId });

function query(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function compactCart(cart: Cart) {
  return {
    items: cart.lines.map((l) => ({ sku: l.sku, title: l.title, qty: l.qty, unitPriceRupees: rupees(l.unitPrice), lineTotalRupeesInclGst: rupees(l.lineTotal) })),
    totalRupeesInclGst: rupees(cart.total),
    volumeSavingsRupees: rupees(cart.savings),
  };
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'search_products',
    description: 'Search the business catalog. Returns matching products with GST-exclusive unit prices in rupees.',
    mutating: false,
    parameters: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120, description: 'What to search for, e.g. "a4 paper"' },
        category: { type: 'string', maxLength: 60, description: 'Optional exact category name' },
        maxUnitPriceRupees: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Optional maximum unit price in rupees' },
        gstInvoiceOnly: { type: 'boolean', description: 'Only sellers that issue GST invoices (for input tax credit)' },
        limit: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
    async run(args, ctx) {
      const result = await ctx.catalog.json<SearchResult>('GET', '/v1/products', {
        ...headers(ctx),
        query: query({
          q: args.query as string,
          category: args.category as string | undefined,
          maxUnitPrice: args.maxUnitPriceRupees ? (args.maxUnitPriceRupees as number) * 100 : undefined,
          gstInvoice: args.gstInvoiceOnly ? 'true' : undefined,
          limit: (args.limit as number | undefined) ?? 3,
        }),
      });
      return {
        total: result.total,
        results: result.items.map((p) => ({
          sku: p.sku,
          title: p.title,
          unit: p.unit,
          unitPriceRupees: rupees(p.unitPrice),
          gstInvoice: p.gstInvoice,
          deliveryDays: p.deliveryDays,
          rating: p.rating,
          bestVolumeDiscountPercent: p.bestTierDiscountBps / 100,
        })),
      };
    },
    summarize: (args, result) => `Searched "${String(args.query)}": ${(result as { total: number }).total} match(es)`,
  },
  {
    name: 'get_quote',
    description: 'Price a list of SKUs and quantities with volume discounts and GST, without changing the cart.',
    mutating: false,
    parameters: {
      type: 'object',
      required: ['items'],
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            required: ['sku', 'qty'],
            additionalProperties: false,
            properties: { sku: { type: 'string', minLength: 1, maxLength: 40 }, qty: { type: 'integer', minimum: 1, maximum: 10_000 } },
          },
        },
      },
    },
    async run(args, ctx) {
      const quote = await ctx.catalog.json<Quote>('POST', '/v1/quotes', { ...headers(ctx), body: { items: args.items } });
      return {
        lines: quote.lines.map((l) => ({ sku: l.sku, title: l.title, qty: l.qty, unitPriceRupees: rupees(l.unitPrice), discountPercent: l.discountBps / 100, inStock: l.available })),
        subtotalRupees: rupees(quote.subtotal),
        gstRupees: rupees(quote.gst),
        totalRupeesInclGst: rupees(quote.total),
        unknownSkus: quote.unknownSkus,
      };
    },
    summarize: (_args, result) => `Priced ${(result as { lines: unknown[] }).lines.length} item(s)`,
  },
  {
    name: 'get_budgets',
    description: "Show the user's cost centers with their remaining monthly budget in rupees.",
    mutating: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const { items } = await ctx.orders.json<{ items: Budget[] }>('GET', '/v1/budgets', headers(ctx));
      return { budgets: items.map((b) => ({ costCenterId: b.costCenterId, name: b.name, availableRupees: rupees(b.available), budgetRupees: rupees(b.budget) })) };
    },
    summarize: (_args, result) => `Checked ${(result as { budgets: unknown[] }).budgets.length} budget(s)`,
  },
  {
    name: 'view_cart',
    description: "Show the user's current cart with prices.",
    mutating: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      return compactCart(await ctx.orders.json<Cart>('GET', '/v1/cart', headers(ctx)));
    },
    summarize: (_args, result) => `Viewed cart: ${(result as { items: unknown[] }).items.length} item(s)`,
  },
  {
    name: 'list_orders',
    description: "List the user's recent orders, optionally filtered by status.",
    mutating: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['PENDING_APPROVAL', 'PLACED', 'REJECTED', 'CANCELLED'] },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
    async run(args, ctx) {
      const page = await ctx.orders.json<Paged<OrderSummary>>('GET', '/v1/orders', {
        ...headers(ctx),
        query: query({ status: args.status as string | undefined, limit: (args.limit as number | undefined) ?? 5 }),
      });
      return {
        orders: page.items.map((o) => ({
          orderId: o.id,
          number: o.number,
          status: o.status,
          waitingFor: o.currentApproverRole,
          totalRupeesInclGst: rupees(o.total),
          costCenter: o.costCenterName,
          items: o.itemCount,
          createdAt: o.createdAt,
        })),
      };
    },
    summarize: (_args, result) => `Found ${(result as { orders: unknown[] }).orders.length} order(s)`,
  },
  {
    name: 'add_to_cart',
    description: 'Propose adding a quantity of a SKU to the cart. The user must confirm in the app before it happens.',
    mutating: true,
    parameters: {
      type: 'object',
      required: ['sku', 'qty'],
      additionalProperties: false,
      properties: { sku: { type: 'string', minLength: 1, maxLength: 40 }, qty: { type: 'integer', minimum: 1, maximum: 10_000 } },
    },
    async describe(args, ctx) {
      const quote = await ctx.catalog.json<Quote>('POST', '/v1/quotes', { ...headers(ctx), body: { items: [{ sku: args.sku, qty: args.qty }] } });
      const line = quote.lines[0];
      if (!line) throw new ToolInputError(`Unknown SKU ${String(args.sku)}; search first and use a SKU from the results`);
      if (!line.available) throw new ToolInputError(`Only ${line.stock} units of ${line.title} are in stock`);
      const discount = line.discountBps > 0 ? ` (${line.discountBps / 100}% volume discount)` : '';
      return { summary: `Add ${line.qty} × ${line.title} at ${formatInr(line.unitPrice)} each${discount}, ${formatInr(line.lineTotal)} incl. GST` };
    },
    async run(args, ctx, idempotencyKey) {
      const cart = await ctx.orders.json<Cart>('POST', '/v1/cart/items', { ...headers(ctx), body: { sku: args.sku, qty: args.qty }, idempotencyKey });
      return compactCart(cart);
    },
    summarize: () => 'Waiting for your confirmation',
  },
  {
    name: 'reorder',
    description: 'Propose adding every line of a previous order to the cart. The user must confirm in the app.',
    mutating: true,
    parameters: {
      type: 'object',
      required: ['orderId'],
      additionalProperties: false,
      properties: { orderId: { type: 'string', pattern: '^ord_[a-z0-9]+$' } },
    },
    async describe(args, ctx) {
      let order: Order;
      try {
        order = await ctx.orders.json<Order>('GET', `/v1/orders/${encodeURIComponent(String(args.orderId))}`, headers(ctx));
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new ToolInputError('That order was not found; list orders first');
        throw error;
      }
      if (order.requesterId !== ctx.userId) throw new ToolInputError('You can only reorder your own orders');
      const items = order.lines.map((l) => `${l.qty} × ${l.title}`).join(', ');
      return { summary: `Add the ${order.lines.length} item(s) from order #${order.number} to your cart: ${items}` };
    },
    async run(args, ctx, idempotencyKey) {
      const cart = await ctx.orders.json<Cart>('POST', `/v1/orders/${encodeURIComponent(String(args.orderId))}/reorder`, { ...headers(ctx), idempotencyKey });
      return compactCart(cart);
    },
    summarize: () => 'Waiting for your confirmation',
  },
  {
    name: 'place_order',
    description: 'Propose checking out the current cart on a cost center. The user must confirm; approval rules may apply.',
    mutating: true,
    parameters: {
      type: 'object',
      required: ['costCenterId'],
      additionalProperties: false,
      properties: {
        costCenterId: { type: 'string', pattern: '^cc_[a-z0-9_]{1,30}$' },
        poNumber: { type: 'string', maxLength: 40, pattern: '^[A-Za-z0-9 /_-]*$' },
      },
    },
    async describe(args, ctx) {
      let preview: OrderPreview;
      try {
        preview = await ctx.orders.json<OrderPreview>('POST', '/v1/orders/preview', { ...headers(ctx), body: { costCenterId: args.costCenterId } });
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) throw new ToolInputError(error.message);
        throw error;
      }
      const approvals = preview.requiredApprovals.map((a) => a.role.replace('_', ' ').toLowerCase()).join(' → ');
      const route = approvals ? `it will need approval from ${approvals}` : 'it is within policy and will be placed immediately';
      return {
        summary: `Place an order for ${preview.quote.lines.length} item(s), ${formatInr(preview.quote.total)} incl. GST; ${route}`,
        // Pin exactly what the user is confirming: the cart, its total and the approval policy.
        // If any of them changes before confirmation, checkout fails safely instead.
        execArgs: {
          ...args,
          expectedItems: preview.quote.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
          expectedTotal: preview.quote.total,
          expectedPolicyVersion: preview.policyVersion,
        },
      };
    },
    async run(args, ctx, idempotencyKey) {
      const order = await ctx.orders.json<Order>('POST', '/v1/orders', {
        ...headers(ctx),
        body: {
          costCenterId: args.costCenterId,
          poNumber: args.poNumber,
          expectedItems: args.expectedItems,
          expectedTotal: args.expectedTotal,
          expectedPolicyVersion: args.expectedPolicyVersion,
        },
        idempotencyKey,
      });
      return { orderId: order.id, number: order.number, status: order.status, totalRupeesInclGst: rupees(order.total) };
    },
    summarize: () => 'Waiting for your confirmation',
  },
];
