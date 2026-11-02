import { formatInr } from '@procurepilot/sdk';
import { linePreview, nextTier, tierFor } from '../src/pricing';

const tiers = [
  { minQty: 1, discountBps: 0, unitPrice: 29_900 },
  { minQty: 10, discountBps: 500, unitPrice: 28_405 },
  { minQty: 50, discountBps: 1200, unitPrice: 26_312 },
];

describe('volume pricing preview', () => {
  it('picks the tier for the quantity and the next tier to unlock', () => {
    expect(tierFor(tiers, 9).unitPrice).toBe(29_900);
    expect(tierFor(tiers, 10).unitPrice).toBe(28_405);
    expect(tierFor(tiers, 75).unitPrice).toBe(26_312);
    expect(nextTier(tiers, 12)?.minQty).toBe(50);
    expect(nextTier(tiers, 50)).toBeNull();
  });

  it('matches the server quote, including 12% GST', () => {
    const preview = linePreview(tiers, 20, 1200);
    expect(preview).toEqual({ unitPrice: 28_405, discountBps: 500, subtotal: 568_100, gst: 68_172, total: 636_272 });
    expect(formatInr(preview.total)).toBe('₹6,362.72');
  });
});
