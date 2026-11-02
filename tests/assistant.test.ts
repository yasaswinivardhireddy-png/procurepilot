import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ApiError, createClient, type ProcurePilotClient } from '../sdk/src/index.ts';
import { runAgent } from '../server/src/assistant/agent.ts';
import { FallbackProvider, type LlmInput, type LlmProvider, type LlmTurn } from '../server/src/assistant/llm.ts';
import { GeminiProvider, toContents } from '../server/src/assistant/providers/gemini.ts';
import { OfflinePlanner, parseIntent } from '../server/src/assistant/providers/offline.ts';
import { TOOLS } from '../server/src/assistant/tools.ts';
import { startStack, type Stack } from '../server/src/stack.ts';

describe('intent parsing (offline planner)', () => {
  it('extracts items, quantities and filters from a shopping request', () => {
    const intent = parseIntent('Please order 20 reams of A4 paper and 10 packs of gel pens with GST invoice under ₹500');
    assert.equal(intent.kind, 'shop');
    if (intent.kind !== 'shop') return;
    assert.deepEqual(intent.items, [
      { qty: 20, query: 'a4 paper' },
      { qty: 10, query: 'gel pens' },
    ]);
    assert.deepEqual([intent.add, intent.gstOnly, intent.maxRupees], [true, true, 500]);
  });

  it('recognizes budget, cart, orders, reorder and checkout requests', () => {
    assert.equal(parseIntent('What is my remaining budget?').kind, 'budget');
    assert.equal(parseIntent("what's in my cart").kind, 'cart');
    assert.deepEqual(parseIntent('show my pending approvals'), { kind: 'orders', status: 'PENDING_APPROVAL' });
    assert.equal(parseIntent('Reorder my last order').kind, 'reorder');
    assert.deepEqual(parseIntent('Place the order on Facilities with PO 4512'), { kind: 'checkout', costCenterHint: 'facilities', poNumber: 'PO-4512' });
    assert.equal(parseIntent('find the cheapest wireless mice').kind, 'shop');
    assert.equal(parseIntent('hello there!').kind, 'help');
  });
});

// A scripted "model" for testing the loop itself.
class ScriptedProvider implements LlmProvider {
  name = 'scripted';
  turns: LlmTurn[];
  inputs: LlmInput[] = [];
  constructor(turns: LlmTurn[]) {
    this.turns = turns;
  }
  async next(input: LlmInput): Promise<LlmTurn> {
    this.inputs.push(structuredClone(input));
    return this.turns.shift() ?? { text: 'done', toolCalls: [] };
  }
}

describe('assistant (all services)', () => {
  let stack: Stack;
  let asha: ProcurePilotClient;
  let vikram: ProcurePilotClient;

  before(async () => {
    stack = await startStack();
    const signIn = async (userId: string) =>
      createClient({ baseUrl: stack.gatewayUrl, token: (await createClient({ baseUrl: stack.gatewayUrl }).demoLogin(userId)).token });
    [asha, vikram] = await Promise.all([signIn('u_asha'), signIn('u_vikram')]);
  });
  after(() => stack.close());

  const ctx = () => ({ userId: 'u_asha', requestId: 'test', catalog: stack.gateway.upstreams.catalog, orders: stack.gateway.upstreams.orders });

  it('feeds tool errors back to the model and never runs mutations directly', async () => {
    await asha.clearCart();
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: '1', name: 'drop_tables', args: {} },
          { id: '2', name: 'add_to_cart', args: { sku: 'OFF-A4-JK75', qty: -5 } },
          { id: '3', name: 'add_to_cart', args: { sku: 'OFF-A4-JK75', qty: 5 } },
        ],
      },
      { text: 'Tap Confirm to add the paper.', toolCalls: [] },
    ]);
    const result = await runAgent({ provider, tools: TOOLS, ctx: ctx(), history: [], message: 'add paper' });
    assert.deepEqual(
      result.steps.map((s) => s.status),
      ['error', 'error', 'awaiting_confirmation'],
    );
    const fedBack = provider.inputs[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { result: { error?: string } }).result);
    assert.match(String(fedBack[0]!.error), /Unknown tool/);
    assert.equal(fedBack[1]!.error, 'Invalid arguments');
    assert.equal(result.proposals.length, 1);
    assert.equal((await asha.getCart()).itemCount, 0, 'nothing changes until the user confirms');
  });

  it('stops after the step limit', async () => {
    const loop = { text: '', toolCalls: [{ id: 'x', name: 'get_budgets', args: {} }] };
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => structuredClone(loop)));
    const result = await runAgent({ provider, tools: TOOLS, ctx: ctx(), history: [], message: 'loop', maxSteps: 3 });
    assert.equal(provider.inputs.length, 3);
    assert.match(result.reply, /could not finish/);
  });

  it('executes a confirmed action exactly once, even when confirm is tapped repeatedly', async () => {
    await asha.clearCart();
    const turn = await asha.askAssistant('Order 20 reams of A4 paper with GST invoice');
    assert.equal(turn.provider, 'offline-planner');
    assert.equal(turn.actions.length, 1);
    const action = turn.actions[0]!;
    assert.match(action.summary, /Add 20 × JK Copier A4 Paper/);
    const results = await Promise.all([asha.confirmAction(action.id), asha.confirmAction(action.id), asha.confirmAction(action.id)]);
    assert.ok(results.every((r) => r.status === 'EXECUTED'));
    assert.equal((await asha.confirmAction(action.id)).status, 'EXECUTED');
    const cart = await asha.getCart();
    assert.deepEqual(
      cart.lines.map((l) => [l.sku, l.qty]),
      [['OFF-A4-JK75', 20]],
    );
  });

  it('keeps actions private to their owner and honors cancel', async () => {
    const turn = await asha.askAssistant('add 5 boxes of nitrile gloves');
    const action = turn.actions[0]!;
    await assert.rejects(vikram.confirmAction(action.id), (e: unknown) => e instanceof ApiError && e.status === 404);
    assert.equal((await asha.cancelAction(action.id)).status, 'CANCELLED');
    await assert.rejects(asha.confirmAction(action.id), (e: unknown) => e instanceof ApiError && e.code === 'action_not_pending');
  });

  it('never lets a cancel override an execution in progress, and retries it safely', async () => {
    await asha.clearCart();
    const action = (await asha.askAssistant('add 3 boxes of nitrile gloves')).actions[0]!;
    // Simulate an execution whose outcome is unknown, for example after a lost response.
    assert.ok(stack.assistant.store.transition(action.id, 'PENDING', 'EXECUTING'));
    assert.equal((await asha.cancelAction(action.id)).status, 'EXECUTING');
    assert.equal((await asha.confirmAction(action.id)).status, 'EXECUTED');
    assert.equal((await asha.getCart()).lines.find((l) => l.sku === 'SAF-GLV-NIT100')?.qty, 3);
  });

  it('pins the reviewed cart when the agent prepares a checkout', async () => {
    await asha.clearCart();
    await asha.setCartItem('PAN-WAT-BIS24', 10);
    const turn = await asha.askAssistant('place the order on marketing with PO 7781');
    const action = turn.actions[0]!;
    assert.equal(action.tool, 'place_order');
    await asha.setCartItem('PAN-WAT-BIS24', 11);
    await assert.rejects(asha.confirmAction(action.id), (e: unknown) => e instanceof ApiError && e.code === 'cart_changed');
    await asha.clearCart();
  });

  it('answers budget questions with live data', async () => {
    const turn = await asha.askAssistant('What is my remaining budget?');
    assert.match(turn.reply, /Marketing: ₹[\d,]+\.\d{2} left of ₹3,00,000\.00/);
  });
});

describe('Gemini adapter', () => {
  it('maps tools and messages to the Gemini API and replays thought signatures', async () => {
    const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const responses = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { functionCall: { name: 'get_budgets', args: {} }, thoughtSignature: 'c2lnLTE=' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'You have ₹2,500 left.' }] } }] },
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-test', fetch: fakeFetch });
    const tools = TOOLS.filter((t) => t.name === 'get_budgets' || t.name === 'add_to_cart');

    const first = await provider.next({ system: 'sys', messages: [{ role: 'user', text: 'budget?' }], tools });
    assert.equal(first.text, '', 'thought parts are not shown to users');
    assert.deepEqual(first.toolCalls.map((c) => c.name), ['get_budgets']);
    const body = requests[0]!.body as { tools: { functionDeclarations: Record<string, unknown>[] }[]; systemInstruction: unknown };
    assert.equal(requests[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    assert.equal(requests[0]!.headers['x-goog-api-key'], 'test-key');
    const [budgets, addToCart] = body.tools[0]!.functionDeclarations;
    assert.equal('parameters' in budgets!, false, 'tools without parameters omit the schema');
    assert.equal('additionalProperties' in (addToCart!.parameters as Record<string, unknown>), false);

    const messages = [
      { role: 'user' as const, text: 'budget?' },
      { role: 'assistant' as const, text: first.text, toolCalls: first.toolCalls, raw: first.raw },
      { role: 'tool' as const, callId: first.toolCalls[0]!.id, name: 'get_budgets', result: { budgets: [] } },
    ];
    const second = await provider.next({ system: 'sys', messages, tools });
    assert.equal(second.text, 'You have ₹2,500 left.');
    const contents = (requests[1]!.body as { contents: { role: string; parts: Record<string, unknown>[] }[] }).contents;
    assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
    assert.equal(contents[1]!.parts[1]!.thoughtSignature, 'c2lnLTE=');
    assert.deepEqual(contents[2]!.parts[0], { functionResponse: { name: 'get_budgets', response: { result: { budgets: [] } } } });
  });

  it('merges consecutive turns from the same role', () => {
    const contents = toContents([
      { role: 'assistant', text: 'a', toolCalls: [] },
      { role: 'assistant', text: 'b', toolCalls: [] },
    ]);
    assert.equal(contents.length, 1);
    assert.equal(contents[0]!.parts.length, 2);
  });

  it('falls back to the offline planner when the model is unavailable', async () => {
    const failing = new GeminiProvider({ apiKey: 'k', fetch: (async () => new Response('quota exceeded', { status: 429 })) as typeof fetch });
    const errors: unknown[] = [];
    const provider = new FallbackProvider(failing, new OfflinePlanner(), (e) => errors.push(e));
    const turn = await provider.next({ system: 's', messages: [{ role: 'user', text: 'hello' }], tools: [] });
    assert.equal(provider.lastUsed, 'offline-planner');
    assert.match(turn.text, /I can find supplies/);
    assert.match(String((errors[0] as Error).message), /429/);
  });
});
