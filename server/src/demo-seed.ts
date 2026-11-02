import { createClient, type ProcurePilotClient } from '../../sdk/src/client.ts';
import type { CheckoutRequest } from '../../sdk/src/types.ts';

// Creates realistic demo data through the public API, exactly as the app would.
export async function seedDemo(baseUrl: string): Promise<boolean> {
  const login = async (userId: string): Promise<ProcurePilotClient> => {
    const session = await createClient({ baseUrl }).demoLogin(userId);
    return createClient({ baseUrl, token: session.token });
  };
  const order = async (client: ProcurePilotClient, items: [string, number][], request: CheckoutRequest) => {
    await client.clearCart();
    for (const [sku, qty] of items) await client.setCartItem(sku, qty);
    return client.checkout(request);
  };

  const asha = await login('u_asha');
  if ((await asha.listOrders({ limit: 1 })).total > 0) return false;

  // Within policy: placed immediately.
  await order(asha, [['OFF-A4-JK75', 20], ['OFF-PEN-REY10', 5], ['OFF-STK-3M12', 2]], { costCenterId: 'cc_mkt', poNumber: 'PO-2026-0412' });
  await order(asha, [['PAN-TEA-TAJ1KG', 4], ['PAN-COF-NES500', 2], ['PAN-CUP-150X1000', 2]], { costCenterId: 'cc_ops', poNumber: 'PO-2026-0418' });
  // ₹25,000+ with IT hardware: Manager, then IT admin.
  await order(asha, [['IT-MON-P2425H', 2], ['IT-HDMI-2M', 2]], { costCenterId: 'cc_mkt', poNumber: 'PO-2026-0431', note: 'Monitors for the two new design hires' });

  const vikram = await login('u_vikram');
  const laptop = await order(vikram, [['IT-LAP-E14G6', 1], ['IT-MSE-M331', 1]], { costCenterId: 'cc_eng', poNumber: 'PO-2026-0436', note: 'Laptop for a new joiner' });
  await order(vikram, [['IT-HDS-EV230', 1], ['OFF-NB-CLS6', 2]], { costCenterId: 'cc_eng' });

  // The engineering manager has approved the laptop; it now waits for IT.
  const neha = await login('u_neha');
  await neha.approveOrder(laptop.id, { version: laptop.version, comment: 'Approved for the new joiner' });

  // Leave something in Asha's cart.
  await asha.setCartItem('OFF-A4-JK70', 10);
  await asha.setCartItem('CLN-DET-HW15', 6);
  return true;
}
