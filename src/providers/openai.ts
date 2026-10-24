// OpenAI-compatible Chat Completions streaming adapter.
// Covers openai, groq, mistral, openrouter, deepseek and any custom /v1.
import { ProviderError } from '../types.ts';
import type {
  ChatMessage,
  Provider,
  StreamEvent,
  ToolCall,
  ToolDef,
} from '../types.ts';
import type { ProviderMeta } from './base.ts';
import { readErrorBody, streamSse } from './sse.ts';

interface WireMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant') {
      const wire: WireMessage = { role: 'assistant', content: msg.content || null };
      if (msg.toolCalls?.length) {
        wire.tool_calls = msg.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
      }
      return wire;
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId || '',
        content: msg.content || '',
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

export function openaiCompatStreamUrl(apiBase: string): string {
  return `${apiBase.replace(/\/$/, '')}/chat/completions`;
}

interface Fragment {
  id: string;
  name: string;
  args: string;
}

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly label = 'openai-compat';
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly reasoningEffort?: string;
  private readonly maxTokens: number;

  constructor(
    meta: ProviderMeta,
    apiBase: string,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
    reasoningEffort?: string,
    maxTokens?: number,
  ) {
    this.apiBase = apiBase;
    this.apiKey = apiKey;
    this.extraHeaders = extraHeaders;
    this.name = meta.name;
    this.model = meta.model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = maxTokens || 8192;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(messages),
      stream: true,
      max_tokens: this.maxTokens,
    };
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    const response = await fetch(openaiCompatStreamUrl(this.apiBase), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = response.body ? await readErrorBody(response) : '';
      const hint =
        response.status === 401 || response.status === 403
          ? ' (API key rejected - run: ardan keys test ' + this.name + ')'
          : response.status === 404
            ? ` (model '${this.model}' not found at ${this.apiBase})`
            : '';
      throw new ProviderError(
        `HTTP ${response.status}${hint}: ${detail}`,
        this.name,
        response.status,
      );
    }

    const fragments = new Map<number, Fragment>();
    for await (const payload of streamSse(response.body)) {
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const index = fragment.index ?? 0;
          const slot = fragments.get(index) || { id: '', name: '', args: '' };
          if (fragment.id) slot.id = fragment.id;
          if (fragment.function?.name) slot.name = fragment.function.name;
          if (fragment.function?.arguments) {
            slot.args += fragment.function.arguments;
          }
          fragments.set(index, slot);
        }
      }
    }

    const ordered = [...fragments.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, slot] of ordered) {
      let args: Record<string, unknown> = {};
      try {
        args = slot.args ? JSON.parse(slot.args) : {};
      } catch {
        args = { _raw: slot.args };
      }
      const call: ToolCall = {
        id: slot.id || `call_${slot.name}`,
        name: slot.name,
        args,
      };
      yield { type: 'tool_call', call };
    }
    yield { type: 'end' };
  }

  async listModels(): Promise<string[]> {
    if (!this.apiKey) return [];
    try {
      const response = await fetch(`${this.apiBase}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const parsed = await response.json().catch(() => null);
      const rows = parsed?.data || [];
      return rows
        .map((row: any) => String(row?.id || ''))
        .filter((id: string) => id)
        .sort();
    } catch {
      return [];
    }
  }

  async health(): Promise<string> {
    if (!this.apiKey) return 'no API key configured';
    try {
      const response = await fetch(`${this.apiBase}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return `${this.apiBase} reachable, key accepted`;
      if (response.status === 401 || response.status === 403) return 'API key rejected';
      return `HTTP ${response.status} from ${this.apiBase}`;
    } catch (error) {
      return `unreachable: ${(error as Error).message}`;
    }
  }
}
