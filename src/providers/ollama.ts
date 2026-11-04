// Ollama native /api/chat streaming adapter (100% local, zero cost).
import http from 'node:http';
import https from 'node:https';
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

/**
 * POST and stream the response body with node:http. Unlike global fetch
 * (undici, 300s headersTimeout) there is no cap on time-to-first-byte:
 * a CPU-only machine can need minutes to load a 14B model and prefill
 * the tool catalog before Ollama sends its first header.
 */
function postStream(
  url: string,
  payload: string,
  signal: AbortSignal,
): Promise<{ status: number; chunks: AsyncIterable<Buffer> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        signal,
      },
      (response) => resolve({ status: response.statusCode || 0, chunks: response }),
    );
    request.on('error', reject);
    request.end(payload);
  });
}

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
  private readonly maxTokens: number;

  lastTokensPerSecond = 0;

  constructor(
    meta: ProviderMeta,
    baseUrl: string,
    maxTokens = 8192,
  ) {
    this.baseUrl = baseUrl;
    this.model = meta.model;
    this.maxTokens = maxTokens;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(messages),
      stream: true,
      // num_predict caps runaway generations (small models can loop forever)
      options: { temperature: 0.2, num_ctx: NUM_CTX, num_predict: this.maxTokens },
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

    let response: { status: number; chunks: AsyncIterable<Buffer> };
    try {
      response = await postStream(
        `${this.baseUrl.replace(/\/$/, '')}/api/chat`,
        JSON.stringify(body),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      const refused = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH';
      throw new ProviderError(
        refused
          ? `Ollama unreachable at ${this.baseUrl}. Start it with: ollama serve  (${code})`
          : `Ollama request failed at ${this.baseUrl}: ${(error as Error).message}`,
        'ollama',
      );
    }

    if (response.status < 200 || response.status >= 300) {
      let detail = '';
      for await (const part of response.chunks) detail += part.toString('utf8');
      if (response.status === 404) {
        throw new ProviderError(
          `model '${this.model}' not pulled. Run: ollama pull ${this.model}`,
          'ollama',
          404,
        );
      }
      throw new ProviderError(`HTTP ${response.status}: ${detail.slice(0, 300)}`, 'ollama', response.status);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let callIndex = 0;
    let tokensPerSecond = 0;

    const handleLine = async (line: string): Promise<AsyncGenerator<StreamEvent>> => (async function* () {
      const chunk = JSON.parse(line);
      const message = chunk?.message || {};
      if (message.content) yield { type: 'text', text: message.content } as StreamEvent;
      if (Array.isArray(message.tool_calls)) {
        for (const wire of message.tool_calls as OllamaToolCallWire[]) {
          const call: ToolCall = {
            id: `call_${callIndex++}_${wire.function.name}`,
            name: wire.function.name,
            args: wire.function.arguments || {},
          };
          yield { type: 'tool_call', call } as StreamEvent;
        }
      }
      if (chunk?.error) throw new ProviderError(`ollama: ${chunk.error}`, 'ollama');
      // generation speed as Ollama measures it (eval_duration is in ns),
      // excluding model load and prompt prefill
      if (chunk?.done && chunk.eval_count && chunk.eval_duration) {
        tokensPerSecond = Math.round(chunk.eval_count / (chunk.eval_duration / 1e9));
      }
    })();

    for await (const value of response.chunks) {
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

    if (tokensPerSecond) this.lastTokensPerSecond = tokensPerSecond;
    yield { type: 'end', tokensPerSecond: tokensPerSecond || undefined };
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
