// Ollama native /api/chat streaming adapter (100% local, zero cost).
import { ProviderError } from '../types.ts';
import type {
  ChatMessage,
  Provider,
  StreamEvent,
  ToolCall,
  ToolDef,
} from '../types.ts';
import type { ProviderMeta } from './base.ts';

const NUM_CTX = Number(process.env.ARDAN_OLLAMA_NUM_CTX || 32768);

interface OllamaToolCallWire {
  function: { name: string; arguments: Record<string, unknown> };
}

function toOllamaMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant') {
      const wire: Record<string, unknown> = { role: 'assistant', content: msg.content || '' };
      if (msg.toolCalls?.length) {
        wire.tool_calls = msg.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.args },
        }));
      }
      return wire;
    }
    return { role: msg.role, content: msg.content || '' };
  });
}

export class OllamaProvider implements Provider {
  readonly name = 'ollama';
  readonly model: string;
  readonly label = 'local';
  private readonly baseUrl: string;

  lastTokensPerSecond = 0;

  constructor(
    meta: ProviderMeta,
    baseUrl: string,
  ) {
    this.baseUrl = baseUrl;
    this.model = meta.model;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const started = performance.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(messages),
      stream: true,
      options: { temperature: 0.2, num_ctx: NUM_CTX },
    };
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

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new ProviderError(
        `Ollama unreachable at ${this.baseUrl}. Start it with: ollama serve  (${(error as Error).message})`,
        'ollama',
      );
    }

    if (!response.ok || !response.body) {
      const detail = response.body ? await response.text() : '';
      if (response.status === 404) {
        throw new ProviderError(
          `model '${this.model}' not pulled. Run: ollama pull ${this.model}`,
          'ollama',
          404,
        );
      }
      throw new ProviderError(`HTTP ${response.status}: ${detail.slice(0, 300)}`, 'ollama', response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let evalTokens = 0;
    let promptTokens = 0;

    const handleLine = async (line: string): AsyncGenerator<StreamEvent> => (async function* () {
      const chunk = JSON.parse(line);
      const message = chunk?.message || {};
      if (message.content) yield { type: 'text', text: message.content } as StreamEvent;
      if (Array.isArray(message.tool_calls)) {
        for (const wire of message.tool_calls as OllamaToolCallWire[]) {
          const call: ToolCall = {
            id: `call_${wire.function.name}`,
            name: wire.function.name,
            args: wire.function.arguments || {},
          };
          yield { type: 'tool_call', call } as StreamEvent;
        }
      }
      if (chunk?.done) {
        if (chunk.eval_count && chunk.eval_duration) {
          evalTokens = chunk.eval_count;
          promptTokens = chunk.prompt_eval_count || 0;
        }
      }
    })();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        yield* await handleLine(line);
      }
    }
    if (buffer.trim()) yield* await handleLine(buffer.trim());

    if (evalTokens) {
      const seconds = (performance.now() - started) / 1000;
      this.lastTokensPerSecond = Math.round(evalTokens / Math.max(0.1, seconds));
    }
    yield { type: 'end', tokensPerSecond: this.lastTokensPerSecond || undefined };
    void promptTokens;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return [];
      const parsed = await response.json();
      return (parsed?.models || [])
        .map((m: any) => String(m.name || ''))
        .filter((name: string) => name)
        .sort();
    } catch {
      return [];
    }
  }

  async health(): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return `HTTP ${response.status}`;
      const parsed = await response.json();
      const names = (parsed?.models || []).map((m: any) => m.name).slice(0, 8);
      return `ollama live at ${this.baseUrl}  models: ${names.join(', ') || 'none pulled yet'}`;
    } catch {
      return `unreachable - start with: ollama serve`;
    }
  }
}
