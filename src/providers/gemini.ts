// Google Gemini streaming adapter (REST + SSE).
import { ProviderError } from '../types.ts';
import type {
  ChatMessage,
  Provider,
  StreamEvent,
  ToolCall,
  ToolDef,
} from '../types.ts';
import type { ProviderMeta } from './base.ts';
import { readErrorBody } from './sse.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function sanitizeSchema(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'additionalProperties' || key === '$schema' || key === '$id') continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: unknown };
}

function toContents(messages: ChatMessage[]): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const call of msg.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: ' ' }] });
      continue;
    }
    if (msg.role === 'tool') {
      const name = messages.find(
        (m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === msg.toolCallId),
      )?.toolCalls?.find((c) => c.id === msg.toolCallId)?.name;
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: name || 'tool',
              response: { result: msg.content },
            },
          },
        ],
      });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: msg.content }] });
  }
  // Gemini requires functionResponse parts to be merged into one user turn
  // per responding assistant functionCall sequence; consecutive user tool
  // responses are fine as separate user turns for v1beta streaming.
  return contents;
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  readonly model: string;
  readonly label = 'google';
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly maxThinkingTokens?: number;

  constructor(
    meta: ProviderMeta,
    apiKey: string,
    options?: { maxTokens?: number; maxThinkingTokens?: number },
  ) {
    this.apiKey = apiKey;
    this.model = meta.model;
    this.maxTokens = options?.maxTokens || 8192;
    this.maxThinkingTokens = options?.maxThinkingTokens;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const body: Record<string, unknown> = {
      contents: toContents(messages),
      generationConfig: { temperature: 0.2, maxOutputTokens: this.maxTokens },
    };
    if (this.maxThinkingTokens) {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingBudget: this.maxThinkingTokens,
      };
    }
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: sanitizeSchema(tool.parameters),
          })),
        },
      ];
    }

    const url = `${API_BASE}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new ProviderError(`network error: ${(error as Error).message}`, this.name);
    }
    if (!response.ok || !response.body) {
      const detail = response.body ? await readErrorBody(response) : '';
      throw new ProviderError(`HTTP ${response.status}: ${detail}`, this.name, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleLine = (line: string): StreamEvent[] => {
      const events: StreamEvent[] = [];
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        return events;
      }
      const parts = parsed?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) events.push({ type: 'text', text: part.text });
        if (part.functionCall) {
          const call: ToolCall = {
            id: `call_${part.functionCall.name}`,
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          };
          events.push({ type: 'tool_call', call });
        }
      }
      return events;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        yield* handleLine(payload);
      }
    }
    if (buffer.startsWith('data:')) {
      yield* handleLine(buffer.slice(5).trim());
    }
    yield { type: 'end' };
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(
        `${API_BASE}/models?pageSize=100`,
        { headers: { 'x-goog-api-key': this.apiKey }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return [];
      const parsed = await response.json();
      return (parsed?.models || [])
        .map((m: any) => String(m.name || '').replace('models/', ''))
        .filter((id: string) => id.includes('gemini'))
        .sort();
    } catch {
      return [];
    }
  }

  async health(): Promise<string> {
    return 'google configured (key present)';
  }
}
