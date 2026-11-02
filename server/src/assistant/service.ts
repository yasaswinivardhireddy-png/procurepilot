import type { AssistantTurn, PendingAction } from '../../../sdk/src/types.ts';
import { HttpError, Router, startService, type RunningService } from '../shared/http.ts';
import { newId } from '../shared/ids.ts';
import { internalAuth, requireUserId } from '../shared/internal-auth.ts';
import { createLogger, type LogLevel, type Logger } from '../shared/log.ts';
import { Registry } from '../shared/metrics.ts';
import { Upstream } from '../shared/resilience.ts';
import { parseBody, type Schema } from '../shared/validate.ts';
import { runAgent } from './agent.ts';
import { FallbackProvider, type AgentMessage, type LlmProvider } from './llm.ts';
import { GeminiProvider } from './providers/gemini.ts';
import { OfflinePlanner } from './providers/offline.ts';
import { AssistantStore, publicAction, type StoredAction } from './store.ts';
import { TOOLS, type ToolContext } from './tools.ts';

export type AssistantConfig = {
  port: number;
  host?: string;
  internalToken: string;
  dbPath: string;
  catalogUrl: string;
  ordersUrl: string;
  logLevel?: LogLevel;
  provider?: LlmProvider;
  actionTtlMs?: number;
};

export type AssistantService = RunningService & { store: AssistantStore };

const TURN_SCHEMA: Schema = {
  type: 'object',
  required: ['message'],
  additionalProperties: false,
  properties: {
    message: { type: 'string', minLength: 1, maxLength: 500 },
    conversationId: { type: 'string', pattern: '^conv_[a-z0-9]+$' },
  },
};

export function providerFromEnv(logger: Logger, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const offline = new OfflinePlanner();
  if (!env.GEMINI_API_KEY) return offline;
  const gemini = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || undefined });
  return new FallbackProvider(gemini, offline, (error) => logger.warn('llm_fallback', { error: (error as Error).message }));
}

export async function startAssistantService(config: AssistantConfig): Promise<AssistantService> {
  const logger = createLogger('assistant', config.logLevel);
  const registry = new Registry();
  const store = new AssistantStore(config.dbPath);
  const provider = config.provider ?? providerFromEnv(logger);
  const catalog = new Upstream({ name: 'catalog', baseUrl: config.catalogUrl, internalToken: config.internalToken, registry, logger });
  const orders = new Upstream({ name: 'orders', baseUrl: config.ordersUrl, internalToken: config.internalToken, registry, logger, timeoutMs: 5_000 });
  const toolCalls = registry.counter('agent_tool_calls_total', 'Tool calls made by the agent, by outcome');
  const turns = registry.counter('agent_turns_total', 'Assistant turns by provider');
  const turnLatency = registry.histogram('agent_turn_duration_seconds', 'End-to-end assistant turn latency', [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
  const actionsDecided = registry.counter('agent_actions_total', 'Confirmed or cancelled assistant actions');
  const byTool = new Map(TOOLS.map((t) => [t.name, t]));
  const inFlight = new Map<string, Promise<PendingAction>>();
  const ttlMs = config.actionTtlMs ?? 10 * 60_000;

  const ownedAction = (id: string, userId: string): StoredAction => {
    const action = store.getAction(id);
    if (!action || action.userId !== userId) throw new HttpError(404, 'action_not_found', 'Action not found');
    if (action.status === 'PENDING' && Date.parse(action.expiresAt) < Date.now()) {
      store.transition(action.id, 'PENDING', 'EXPIRED');
      return store.getAction(id)!;
    }
    return action;
  };

  const router = new Router();

  router.post('/v1/assistant/turns', async (req) => {
    const userId = requireUserId(req);
    const body = parseBody<{ message: string; conversationId?: string }>(TURN_SCHEMA, req.body);
    const conversationId = body.conversationId ?? newId('conv');
    const memory = body.conversationId ? store.getConversation(body.conversationId, userId) : [];
    if (memory === null) throw new HttpError(404, 'conversation_not_found', 'Conversation not found');
    const history: AgentMessage[] = memory.map((m) => (m.role === 'user' ? { role: 'user', text: m.text } : { role: 'assistant', text: m.text, toolCalls: [] }));
    const ctx: ToolContext = { userId, requestId: req.requestId, catalog, orders };
    const started = performance.now();
    const result = await runAgent({ provider, tools: TOOLS, ctx, history, message: body.message, toolCalls });
    const providerName = provider instanceof FallbackProvider ? provider.lastUsed : provider.name;
    turns.inc({ provider: providerName });
    turnLatency.observe({ provider: providerName }, (performance.now() - started) / 1000);
    const actions = result.proposals.map((p) =>
      publicAction(store.createAction({ userId, conversationId, tool: p.tool, args: p.args, execArgs: p.execArgs, summary: p.summary, ttlMs })),
    );
    store.saveConversation(conversationId, userId, [...memory, { role: 'user', text: body.message }, { role: 'assistant', text: result.reply }]);
    const turn: AssistantTurn = { conversationId, reply: result.reply, steps: result.steps, actions, provider: providerName };
    return { body: turn };
  });

  // Executes a confirmed action exactly once. The action is claimed (PENDING -> EXECUTING) before
  // any await, so a concurrent cancel or expiry cannot slip in; concurrent confirms share one
  // in-flight execution; and the action id is the downstream idempotency key. If the outcome is
  // unknown (timeout or outage), the action stays EXECUTING and confirming again replays it safely.
  router.post('/v1/assistant/actions/:id/confirm', async (req) => {
    const userId = requireUserId(req);
    const action = ownedAction(req.params.id!, userId);
    if (action.status === 'EXECUTED') return { body: publicAction(action) };
    let running = inFlight.get(action.id);
    if (!running) {
      if (action.status === 'PENDING') {
        if (!store.transition(action.id, 'PENDING', 'EXECUTING')) {
          const current = store.getAction(action.id)!;
          throw new HttpError(409, 'action_not_pending', `This action is ${current.status.toLowerCase()}`);
        }
      } else if (action.status !== 'EXECUTING') {
        throw new HttpError(409, 'action_not_pending', `This action is ${action.status.toLowerCase()}`);
      }
      running = (async () => {
        const tool = byTool.get(action.tool);
        if (!tool) throw new HttpError(500, 'unknown_tool', `Unknown tool ${action.tool}`);
        const ctx: ToolContext = { userId, requestId: req.requestId, catalog, orders };
        try {
          const result = await tool.run(action.execArgs, ctx, `${action.id}:exec`);
          store.transition(action.id, 'EXECUTING', 'EXECUTED', result);
          actionsDecided.inc({ tool: action.tool, decision: 'executed' });
          const memory = store.getConversation(action.conversationId, userId) ?? [];
          store.saveConversation(action.conversationId, userId, [...memory, { role: 'assistant', text: `Done: ${action.summary}` }]);
        } catch (error) {
          // A business-rule rejection (for example the cart or price changed) is final.
          if (error instanceof HttpError && error.status < 500) {
            store.transition(action.id, 'EXECUTING', 'FAILED', { error: { code: error.code, message: error.message } });
            actionsDecided.inc({ tool: action.tool, decision: 'failed' });
          }
          throw error;
        }
        return publicAction(store.getAction(action.id)!);
      })().finally(() => inFlight.delete(action.id));
      inFlight.set(action.id, running);
    }
    return { body: await running };
  });

  // Only a pending action can be cancelled; otherwise the current state is returned unchanged.
  router.post('/v1/assistant/actions/:id/cancel', (req) => {
    const userId = requireUserId(req);
    const action = ownedAction(req.params.id!, userId);
    if (action.status === 'PENDING' && store.transition(action.id, 'PENDING', 'CANCELLED')) actionsDecided.inc({ tool: action.tool, decision: 'cancelled' });
    return { body: publicAction(store.getAction(action.id)!) };
  });

  router.get('/v1/assistant/actions/:id', (req) => ({ body: publicAction(ownedAction(req.params.id!, requireUserId(req))) }));

  const service = await startService({
    name: 'assistant',
    port: config.port,
    host: config.host,
    router,
    logger,
    metrics: registry,
    middleware: [internalAuth(config.internalToken)],
    onClose: () => store.close(),
  });
  logger.info('llm_provider', { provider: provider.name });
  return { ...service, store };
}
