import type { PriceTier } from '@procurepilot/sdk';

// Client-side preview of volume pricing; the server re-prices authoritatively at checkout.
export function tierFor(tiers: PriceTier[], qty: number): PriceTier {
  let best = tiers[0]!;
  for (const tier of tiers) if (qty >= tier.minQty && tier.minQty >= best.minQty) best = tier;
  return best;
}

export function nextTier(tiers: PriceTier[], qty: number): PriceTier | null {
  return [...tiers].sort((a, b) => a.minQty - b.minQty).find((t) => t.minQty > qty) ?? null;
}

export function linePreview(tiers: PriceTier[], qty: number, gstRateBps: number) {
  const tier = tierFor(tiers, qty);
  const subtotal = tier.unitPrice * qty;
  const gst = Math.round((subtotal * gstRateBps) / 10_000);
  return { unitPrice: tier.unitPrice, discountBps: tier.discountBps, subtotal, gst, total: subtotal + gst };
}
