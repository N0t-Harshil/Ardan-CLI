// Provider registry + lazy failover (openclaude-style: try next on stream-start failure).
import { ProviderError } from '../types.ts';
import type { ChatMessage, Provider, StreamEvent, ToolDef } from '../types.ts';

export class FailoverProvider implements Provider {
  readonly name: string;
  model: string;
  label: string;
  private readonly chain: Provider[];

  constructor(chain: Provider[]) {
    this.chain = chain;
    const head = chain[0];
    this.name = head.name;
    this.model = head.model;
    this.label = head.label;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    let lastError: unknown;
    for (const provider of this.chain) {
      if (signal.aborted) break;
      let emitted = false;
      try {
        for await (const event of provider.stream(messages, tools, signal)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        // Fail over only if the stream never produced output.
        if (signal.aborted || emitted) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new ProviderError('no provider available', 'failover');
  }

  async listModels(): Promise<string[]> {
    return (await this.chain[0].listModels?.()) ?? [];
  }

  async health(): Promise<string> {
    return (await this.chain[0].health?.()) ?? 'unknown';
  }
}

export function buildFailover(primary: Provider, candidates: Provider[]): Provider {
  if (!candidates.length) return primary;
  return new FailoverProvider([primary, ...candidates]);
}
