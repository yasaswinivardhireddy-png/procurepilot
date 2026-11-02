import type { CartItemInput, PriceTier, Product, ProductSummary, Quote, QuoteLine } from '../../../sdk/src/types.ts';
import type { CatalogProduct } from './data.ts';

const BPS = 10_000;

export function tierFor(product: CatalogProduct, qty: number): { minQty: number; discountBps: number } | null {
  let best: { minQty: number; discountBps: number } | null = null;
  for (const tier of product.tiers) if (qty >= tier.minQty && (!best || tier.minQty > best.minQty)) best = tier;
  return best;
}

export function unitPriceAt(product: CatalogProduct, qty: number): number {
  const discount = tierFor(product, qty)?.discountBps ?? 0;
  return Math.round((product.unitPrice * (BPS - discount)) / BPS);
}

export function priceTiers(product: CatalogProduct): PriceTier[] {
  return [
    { minQty: 1, discountBps: 0, unitPrice: product.unitPrice },
    ...[...product.tiers].sort((a, b) => a.minQty - b.minQty).map((t) => ({ ...t, unitPrice: unitPriceAt(product, t.minQty) })),
  ];
}

export function toSummary(p: CatalogProduct): ProductSummary {
  return {
    sku: p.sku,
    title: p.title,
    brand: p.brand,
    category: p.category,
    unit: p.unit,
    unitPrice: p.unitPrice,
    gstRateBps: p.gstRateBps,
    gstInvoice: p.gstInvoice,
    deliveryDays: p.deliveryDays,
    rating: p.rating,
    inStock: p.stock > 0,
    bestTierDiscountBps: Math.max(0, ...p.tiers.map((t) => t.discountBps)),
  };
}

export function toProduct(p: CatalogProduct): Product {
  return { ...toSummary(p), description: p.description, seller: p.seller, stock: p.stock, tiers: priceTiers(p) };
}

// Authoritative pricing used for carts and checkout; clients never send prices.
export function priceQuote(lookup: (sku: string) => CatalogProduct | undefined, items: CartItemInput[]): Quote {
  const lines: QuoteLine[] = [];
  const unknownSkus: string[] = [];
  let subtotal = 0;
  let gst = 0;
  let savings = 0;
  for (const item of items) {
    const product = lookup(item.sku);
    if (!product) {
      unknownSkus.push(item.sku);
      continue;
    }
    const unitPrice = unitPriceAt(product, item.qty);
    const lineSubtotal = unitPrice * item.qty;
    const lineGst = Math.round((lineSubtotal * product.gstRateBps) / BPS);
    lines.push({
      sku: product.sku,
      title: product.title,
      category: product.category,
      unit: product.unit,
      qty: item.qty,
      listUnitPrice: product.unitPrice,
      unitPrice,
      discountBps: tierFor(product, item.qty)?.discountBps ?? 0,
      lineSubtotal,
      gstRateBps: product.gstRateBps,
      gst: lineGst,
      lineTotal: lineSubtotal + lineGst,
      stock: product.stock,
      available: item.qty <= product.stock,
    });
    subtotal += lineSubtotal;
    gst += lineGst;
    savings += (product.unitPrice - unitPrice) * item.qty;
  }
  return { lines, subtotal, gst, total: subtotal + gst, savings, unknownSkus };
}
