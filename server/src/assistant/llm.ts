import type { Schema } from '../shared/validate.ts';

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type AgentMessage =
  | { role: 'user'; text: string }
  // raw keeps the provider's original message (for example Gemini thought signatures) for replay.
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; callId: string; name: string; result: unknown };

export type ToolDeclaration = { name: string; description: string; parameters: Schema };

export type LlmTurn = { text: string; toolCalls: ToolCall[]; raw?: unknown };

export type LlmInput = { system: string; messages: AgentMessage[]; tools: ToolDeclaration[] };

export interface LlmProvider {
  readonly name: string;
  next(input: LlmInput): Promise<LlmTurn>;
}

// Uses the primary model and falls back to the deterministic planner if the model call fails,
// so an LLM outage degrades answers instead of breaking the feature.
export class FallbackProvider implements LlmProvider {
  name: string;
  lastUsed: string;
  #primary: LlmProvider;
  #fallback: LlmProvider;
  #onFallback: (error: unknown) => void;

  constructor(primary: LlmProvider, fallback: LlmProvider, onFallback: (error: unknown) => void = () => {}) {
    this.name = primary.name;
    this.lastUsed = primary.name;
    this.#primary = primary;
    this.#fallback = fallback;
    this.#onFallback = onFallback;
  }

  async next(input: LlmInput): Promise<LlmTurn> {
    try {
      const turn = await this.#primary.next(input);
      this.lastUsed = this.#primary.name;
      return turn;
    } catch (error) {
      this.#onFallback(error);
      this.lastUsed = this.#fallback.name;
      return this.#fallback.next(input);
    }
  }
}
