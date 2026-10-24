// Anthropic Messages streaming adapter (native SSE wire format).
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

const API_VERSION = '2023-06-01';

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

function buildContentBlocks(
  messages: ChatMessage[],
): { system: string; messages: Array<{ role: string; content: ContentBlock[] }> } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const wire: Array<{ role: string; content: ContentBlock[] }> = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      wire.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: ' ' }] });
      continue;
    }
    if (msg.role === 'tool') {
      // tool results ride inside the next user message (merge consecutive)
      const block: ContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId || '',
        content: msg.content || '',
      };
      const last = wire[wire.length - 1];
      if (last && last.role === 'user' && last.content.some((b: any) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        wire.push({ role: 'user', content: [block] });
      }
      continue;
    }
    wire.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
  }
  return { system, messages: wire };
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly label = 'anthropic';
  private readonly apiKey: string;
  private readonly baseUrlOverride?: string;
  private readonly maxTokens: number;
  private readonly alwaysThinking: boolean;
  private readonly maxThinkingTokens: number;
  private readonly maxTokens: number;
  private readonly alwaysThinking: boolean;
  private readonly maxThinkingTokens: number;

  constructor(
    meta: ProviderMeta,
    apiKey: string,
    baseUrlOverride?: string,
    options?: { maxTokens?: number; alwaysThinking?: boolean; maxThinkingTokens?: number },
  ) {
    this.apiKey = apiKey;
    this.baseUrlOverride = baseUrlOverride;
    this.model = meta.model;
    this.maxTokens = options?.maxTokens || 8192;
    this.alwaysThinking = Boolean(options?.alwaysThinking);
    this.maxThinkingTokens = Math.max(1024, Math.min(options?.maxThinkingTokens || 4096, this.maxTokens - 1024));
  }

  private get url(): string {
    const base = (this.baseUrlOverride || 'https://api.anthropic.com').replace(/\/$/, '');
    return `${base}/v1/messages`;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION,
      'Content-Type': 'application/json',
    };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const { system, messages: wire } = buildContentBlocks(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: wire,
      stream: true,
    };
    if (this.alwaysThinking) {
      body.thinking = { type: 'enabled', budget_tokens: this.maxThinkingTokens };
    }
    if (system) body.system = system;
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = response.body ? await readErrorBody(response) : '';
      throw new ProviderError(`HTTP ${response.status}: ${detail}`, this.name, response.status);
    }

    type Block = { type: string; text: string; toolName: string; toolJson: string; id: string };
    const blocks = new Map<number, Block>();
    let stopReason = '';

    for await (const payload of streamSse(response.body)) {
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (event?.type) {
        case 'content_block_start': {
          const block = event.content_block || {};
          blocks.set(event.index, {
            type: block.type,
            text: '',
            toolName: block.name || '',
            toolJson: '',
            id: block.id || '',
          });
          break;
        }
        case 'content_block_delta': {
          const slot = blocks.get(event.index);
          if (!slot) break;
          if (event.delta?.type === 'text_delta') slot.text += event.delta.text;
          if (event.delta?.type === 'thinking_delta') slot.text += event.delta.thinking || '';
          if (event.delta?.type === 'input_json_delta') slot.toolJson += event.delta.partial_json;
          break;
        }
        case 'message_delta': {
          stopReason = event.delta?.stop_reason || stopReason;
          break;
        }
        default:
          break;
      }
    }

    // Text blocks first ( streamed separately for live output ), then tools.
    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, block] of ordered) {
      if (block.type === 'text' && block.text) {
        yield { type: 'text', text: block.text };
      }
    }
    for (const [, block] of ordered) {
      if (block.type === 'tool_use') {
        let args: Record<string, unknown> = {};
        try {
          args = block.toolJson ? JSON.parse(block.toolJson) : {};
        } catch {
          args = { _raw: block.toolJson };
        }
        yield {
          type: 'tool_call',
          call: { id: block.id, name: block.toolName, args },
        };
      }
    }
    if (stopReason === 'max_tokens') {
      // Anthropic caps low; surface instead of silently truncating.
      yield { type: 'text', text: '\n[truncated: response hit max_tokens]' };
    }
    yield { type: 'end' };
  }

  async listModels(): Promise<string[]> {
    // Static proven-stable catalogue (the /v1/models endpoint needs special API).
    return ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'];
  }

  async health(): Promise<string> {
    if (!this.apiKey) return 'no API key';
    return 'anthropic configured (key present)';
  }
}
