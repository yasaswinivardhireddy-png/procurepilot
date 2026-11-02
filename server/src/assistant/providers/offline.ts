import { formatInr } from '../../../../sdk/src/format.ts';
import type { OrderStatus } from '../../../../sdk/src/types.ts';
import type { AgentMessage, LlmInput, LlmProvider, LlmTurn, ToolCall } from '../llm.ts';

// A deterministic, rule-based planner that speaks the same tool-calling protocol as an LLM.
// It powers tests, CI and demos without an API key, and is the fallback when the model is down.

export type ShopItem = { query: string; qty: number | null };

export type Intent =
  | { kind: 'help' }
  | { kind: 'budget' }
  | { kind: 'cart' }
  | { kind: 'orders'; status?: OrderStatus }
  | { kind: 'reorder' }
  | { kind: 'checkout'; costCenterHint: string | null; poNumber: string | null }
  | { kind: 'shop'; items: ShopItem[]; add: boolean; gstOnly: boolean; maxRupees: number | null; cheapest: boolean };

const UNIT_WORDS = '(?:reams?|boxes|box|packs?|packets?|units?|pieces?|pcs|bottles?|cartons?|cans?|jars?|kits?|sets?|rolls?)';
const ITEM_RE = new RegExp(`^(\\d{1,5})\\s*(?:x\\s+|×\\s*)?(?:${UNIT_WORDS}\\s+(?:of\\s+)?)?(.+)$`);
const PRICE_CAP_RE = /\b(?:under|below|less than|within|max(?:imum)?|upto|up to)\s*(?:rs\.?|inr|₹)?\s*([\d,]+)(?:\s*(?:each|per unit|apiece))?/;

function cleanQuery(text: string): string {
  return text
    .replace(/\b(some|a few|a|an|the|of|more|new)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItem(chunk: string): ShopItem {
  const m = ITEM_RE.exec(chunk);
  if (m) return { qty: Number(m[1]), query: cleanQuery(m[2]!) };
  return { qty: null, query: cleanQuery(chunk) };
}

function matchCostCenter(text: string): string | null {
  const m = /\b(marketing|engineering|facilities|ops|operations)\b/.exec(text);
  if (!m) return null;
  return m[1] === 'ops' || m[1] === 'operations' ? 'facilities' : m[1]!;
}

function matchPo(text: string): string | null {
  const m = /\bPO[\s#:-]*([A-Za-z0-9/_-]{2,30})\b/i.exec(text);
  return m ? `PO-${m[1]}` : null;
}

export function parseIntent(input: string): Intent {
  const t = input.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t === '' || /^(hi|hello|hey|thanks|thank you|help|good (morning|afternoon|evening))( there)?[!.?\s]*$/.test(t)) return { kind: 'help' };
  if (/\b(reorder|re-order|order again|buy again|repeat (my )?(last )?order)\b/.test(t)) return { kind: 'reorder' };
  if (/\b(budgets?|remaining|spend(ing)? limit|how much (can|do) (i|we))\b/.test(t)) return { kind: 'budget' };
  if (/\b(checkout|check out|place (the |my |an )?order|submit (the |my )?(order|cart))\b/.test(t)) {
    return { kind: 'checkout', costCenterHint: matchCostCenter(t), poNumber: matchPo(input) };
  }
  if (/\b(what('s| is) in my cart|show (me )?(my )?cart|view (my )?cart|my cart)\b/.test(t)) return { kind: 'cart' };
  if (/\b(my orders|order status|recent orders|pending (orders|approvals?)|where is my order|track)\b/.test(t)) {
    return { kind: 'orders', status: /pending|approval/.test(t) ? 'PENDING_APPROVAL' : undefined };
  }

  const add = /\b(add|buy|order|purchase|need|want|get me)\b/.test(t);
  const gstOnly = /\bgst\b/.test(t);
  const cap = PRICE_CAP_RE.exec(t);
  const cheapest = /\b(cheapest|lowest price|least expensive|cheap)\b/.test(t);
  const body = t
    .replace(new RegExp(PRICE_CAP_RE.source, 'g'), ' ')
    .replace(/\bwith (a )?gst invoices?\b|\bgst invoices?\b|\bgst\b/g, ' ')
    .replace(/\b(the )?(cheapest|lowest price|least expensive|cheap)\b/g, ' ')
    .replace(
      /\b(please|can you|could you|i need|we need|i want|we want|find me|find|search for|search|show me|look for|add|buy|order|get me|purchase|to (my|the) cart|in(to)? (my|the) cart|for (the )?(office|team|marketing|engineering|facilities))\b/g,
      ' ',
    )
    .replace(/[?!.]/g, ' ');
  const items = body
    .split(/,|\band\b|\bplus\b|&/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .map(parseItem)
    .filter((i) => i.query.length >= 2)
    .slice(0, 4);
  if (items.length === 0) return { kind: 'help' };
  return {
    kind: 'shop',
    items,
    add: add && items.some((i) => i.qty !== null),
    gstOnly,
    maxRupees: cap ? Number(cap[1]!.replace(/,/g, '')) : null,
    cheapest,
  };
}

const HELP =
  'I can find supplies with business pricing, add them to your cart, check budgets, reorder and place orders. ' +
  'Try "Order 20 reams of A4 paper and 10 packs of gel pens with GST invoice" or "What is my remaining budget?"';

type ToolMessage = Extract<AgentMessage, { role: 'tool' }>;
type SearchResultItem = { sku: string; title: string; unit: string; unitPriceRupees: number; gstInvoice: boolean; deliveryDays: number };

const rupeesText = (rupees: number) => formatInr(Math.round(rupees * 100));
const say = (text: string): LlmTurn => ({ text, toolCalls: [] });

export class OfflinePlanner implements LlmProvider {
  name = 'offline-planner';
  #seq = 0;

  #call(name: string, args: Record<string, unknown>): ToolCall {
    return { id: `plan_${++this.#seq}`, name, args };
  }

  async next({ messages }: LlmInput): Promise<LlmTurn> {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser < 0) return say(HELP);
    const text = (messages[lastUser] as { text: string }).text;
    const tools = messages.slice(lastUser + 1).filter((m): m is ToolMessage => m.role === 'tool');
    const has = (name: string) => tools.some((t) => t.name === name);
    // Tool results are untyped data; the planner reads the shapes its own tools return.
    const results = (name: string): any[] => tools.filter((t) => t.name === name).map((t) => t.result);
    const intent = parseIntent(text);

    switch (intent.kind) {
      case 'help':
        return say(HELP);
      case 'budget': {
        if (!has('get_budgets')) return { text: '', toolCalls: [this.#call('get_budgets', {})] };
        const result = results('get_budgets')[0];
        if (result.error) return say(`I could not load your budgets: ${result.error}`);
        const lines = (result.budgets as { name: string; availableRupees: number; budgetRupees: number }[]).map(
          (b) => `${b.name}: ${rupeesText(b.availableRupees)} left of ${rupeesText(b.budgetRupees)}`,
        );
        return say(lines.length > 0 ? `Remaining budget this month. ${lines.join('; ')}.` : 'You have no cost centers to order on.');
      }
      case 'cart': {
        if (!has('view_cart')) return { text: '', toolCalls: [this.#call('view_cart', {})] };
        return say(describeCart(results('view_cart')[0]));
      }
      case 'orders': {
        if (!has('list_orders')) return { text: '', toolCalls: [this.#call('list_orders', { ...(intent.status ? { status: intent.status } : {}), limit: 5 })] };
        const result = results('list_orders')[0];
        if (result.error) return say(`I could not load your orders: ${result.error}`);
        const orders = result.orders as { number: number; status: string; waitingFor: string | null; totalRupeesInclGst: number }[];
        if (orders.length === 0) return say('You have no matching orders.');
        const lines = orders.map(
          (o) =>
            `#${o.number} ${o.status.replace('_', ' ').toLowerCase()}${o.waitingFor ? ` (waiting for ${o.waitingFor.replace('_', ' ').toLowerCase()})` : ''}, ${rupeesText(o.totalRupeesInclGst)}`,
        );
        return say(`Your recent orders: ${lines.join('; ')}.`);
      }
      case 'reorder': {
        if (!has('list_orders')) return { text: '', toolCalls: [this.#call('list_orders', { status: 'PLACED', limit: 1 })] };
        const orders = results('list_orders')[0]?.orders as { orderId: string }[] | undefined;
        if (!orders || orders.length === 0) return say('You have no placed orders to repeat yet.');
        if (!has('reorder')) return { text: '', toolCalls: [this.#call('reorder', { orderId: orders[0]!.orderId })] };
        return say(describeProposals(tools));
      }
      case 'checkout': {
        if (!has('view_cart')) return { text: '', toolCalls: [this.#call('view_cart', {}), this.#call('get_budgets', {})] };
        const cart = results('view_cart')[0];
        if (cart.error) return say(`I could not load your cart: ${cart.error}`);
        if (cart.items.length === 0) return say('Your cart is empty. Tell me what you need and I will add it.');
        if (!has('place_order')) {
          const budgets = (results('get_budgets')[0]?.budgets ?? []) as { costCenterId: string; name: string; availableRupees: number }[];
          const hinted = intent.costCenterHint ? budgets.find((b) => b.name.toLowerCase().includes(intent.costCenterHint!)) : undefined;
          const chosen = hinted ?? budgets.find((b) => b.availableRupees >= cart.totalRupeesInclGst) ?? budgets[0];
          if (!chosen) return say('You do not have a cost center to order on.');
          return { text: '', toolCalls: [this.#call('place_order', { costCenterId: chosen.costCenterId, ...(intent.poNumber ? { poNumber: intent.poNumber } : {}) })] };
        }
        return say(describeProposals(tools));
      }
      case 'shop': {
        if (!has('search_products')) {
          const filters = {
            ...(intent.gstOnly ? { gstInvoiceOnly: true } : {}),
            ...(intent.maxRupees ? { maxUnitPriceRupees: intent.maxRupees } : {}),
          };
          return { text: '', toolCalls: intent.items.map((item) => this.#call('search_products', { query: item.query, ...filters, limit: 3 })) };
        }
        const searches = results('search_products');
        if (intent.add && !has('add_to_cart')) {
          const adds = intent.items
            .map((item, i) => {
              const found = (searches[i]?.results ?? []) as SearchResultItem[];
              if (!item.qty || found.length === 0) return null;
              const pick = intent.cheapest ? [...found].sort((a, b) => a.unitPriceRupees - b.unitPriceRupees)[0]! : found[0]!;
              return this.#call('add_to_cart', { sku: pick.sku, qty: item.qty });
            })
            .filter((c): c is ToolCall => c !== null);
          if (adds.length > 0) return { text: '', toolCalls: adds };
        }
        const proposals = describeProposals(tools);
        if (has('add_to_cart')) {
          const filters = [intent.gstOnly ? 'sellers with GST invoices' : '', intent.maxRupees ? `under ${rupeesText(intent.maxRupees)}` : ''].filter(Boolean).join(', ');
          const found = intent.items.map((item, i) => `"${item.query}" (${searches[i]?.total ?? 0})`).join(' and ');
          return say(`I searched for ${found}${filters ? ` among ${filters}` : ''} and picked the best match for each.\n\n${proposals}`);
        }
        const parts = intent.items.map((item, i) => describeSearch(item.query, searches[i], intent));
        return say(parts.join('\n\n'));
      }
    }
  }
}

function describeCart(cart: any): string {
  if (cart.error) return `I could not load your cart: ${cart.error}`;
  if (cart.items.length === 0) return 'Your cart is empty.';
  const items = (cart.items as { qty: number; title: string }[]).map((i) => `${i.qty} × ${i.title}`).join(', ');
  return `Your cart has ${cart.items.length} item(s), ${rupeesText(cart.totalRupeesInclGst)} incl. GST: ${items}.`;
}

function describeSearch(query: string, result: any, intent: Extract<Intent, { kind: 'shop' }>): string {
  const filters = [intent.gstOnly ? 'with GST invoice' : '', intent.maxRupees ? `under ${rupeesText(intent.maxRupees)}` : ''].filter(Boolean).join(', ');
  const label = `"${query}"${filters ? ` (${filters})` : ''}`;
  if (!result || result.error) return `I could not search for ${label} right now.`;
  const found = result.results as SearchResultItem[];
  if (found.length === 0) return `I found nothing for ${label}.`;
  const list = found
    .map((p, i) => `${i + 1}. ${p.title}: ${rupeesText(p.unitPriceRupees)}/${p.unit}${p.gstInvoice ? ', GST invoice' : ''}, delivery in ${p.deliveryDays} day(s)`)
    .join('\n');
  return `Top matches for ${label}:\n${list}`;
}

function describeProposals(tools: ToolMessage[]): string {
  const ready: string[] = [];
  const problems: string[] = [];
  for (const t of tools) {
    const r = t.result as { status?: string; summary?: string; error?: string };
    if (r?.status === 'awaiting_user_confirmation' && r.summary) ready.push(r.summary);
    else if (r?.error && (t.name === 'add_to_cart' || t.name === 'reorder' || t.name === 'place_order')) problems.push(r.error);
  }
  const parts: string[] = [];
  if (ready.length === 1) parts.push(`I've prepared this for you: ${ready[0]}. Tap Confirm to go ahead.`);
  if (ready.length > 1) parts.push(`I've prepared ${ready.length} changes. Review them below and tap Confirm on each one you want.`);
  if (problems.length > 0) parts.push(`I could not prepare everything: ${problems.join('; ')}`);
  return parts.join('\n\n') || 'Nothing to confirm.';
}
