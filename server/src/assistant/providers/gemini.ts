import type { Schema } from '../../shared/validate.ts';
import type { AgentMessage, LlmInput, LlmProvider, LlmTurn, ToolCall, ToolDeclaration } from '../llm.ts';

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

export type GeminiOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  temperature?: number;
  fetch?: typeof fetch;
};

const GENERATED_ID = 'gemini_call_';

// Gemini accepts an OpenAPI-style schema subset, so keywords it does not support are dropped.
export function toGeminiSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  delete out.additionalProperties;
  if (schema.type === 'object') out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (schema.type === 'array') out.items = toGeminiSchema(schema.items);
  return out;
}

function declare(tool: ToolDeclaration): Record<string, unknown> {
  const hasParams = tool.parameters.type === 'object' && Object.keys(tool.parameters.properties).length > 0;
  return { name: tool.name, description: tool.description, ...(hasParams ? { parameters: toGeminiSchema(tool.parameters) } : {}) };
}

export function toContents(messages: AgentMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', [{ text: m.text }]);
    } else if (m.role === 'assistant') {
      // Replay the model's own parts verbatim so thought signatures survive multi-step tool use.
      const raw = m.raw as GeminiContent | undefined;
      if (raw?.role === 'model' && Array.isArray(raw.parts)) {
        push('model', raw.parts);
      } else {
        const parts: GeminiPart[] = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.args } });
        if (parts.length > 0) push('model', parts);
      }
    } else {
      const id = m.callId.startsWith(GENERATED_ID) ? undefined : m.callId;
      push('user', [{ functionResponse: { ...(id ? { id } : {}), name: m.name, response: { result: m.result } } }]);
    }
  }
  return contents;
}

export class GeminiProvider implements LlmProvider {
  name: string;
  #apiKey: string;
  #model: string;
  #baseUrl: string;
  #timeoutMs: number;
  #temperature: number;
  #fetch: typeof fetch;

  constructor(options: GeminiOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? 'gemini-3.5-flash';
    this.#baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#temperature = options.temperature ?? 0.2;
    this.#fetch = options.fetch ?? fetch;
    this.name = `gemini:${this.#model}`;
  }

  async next({ system, messages, tools }: LlmInput): Promise<LlmTurn> {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toContents(messages),
      tools: [{ functionDeclarations: tools.map(declare) }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: this.#temperature },
    };
    const res = await this.#fetch(`${this.#baseUrl}/models/${encodeURIComponent(this.#model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gemini API returned ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text) as { candidates?: { content?: GeminiContent; finishReason?: string }[] };
    const content = data.candidates?.[0]?.content;
    if (!content || !Array.isArray(content.parts)) {
      throw new Error(`Gemini returned no content (finishReason: ${data.candidates?.[0]?.finishReason ?? 'unknown'})`);
    }
    let generated = 0;
    const toolCalls: ToolCall[] = content.parts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: p.functionCall!.id ?? `${GENERATED_ID}${++generated}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
    const reply = content.parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    return { text: reply, toolCalls, raw: { role: 'model', parts: content.parts } };
  }
}
