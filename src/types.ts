// Shared types for the Ardan agent loop (openclaude/Claude-Code-style).

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** Provider-neutral message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For assistant messages with tool calls. */
  toolCalls?: ToolCall[];
  /** For tool results. */
  toolCallId?: string;
}

export type ToolOutcome = {
  ok: boolean;
  output: string;
};

export interface ToolContext {
  workdir: string;
  sessionId: string;
  signal: AbortSignal;
  /** Extra state bag (todo list, mcp servers, ...). */
  state: Map<string, unknown>;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * How the permission gate treats this tool when mode is "ask".
   * read-only tools run silently.
   */
  readonly permission: 'auto' | 'write' | 'bash' | 'mcp' | 'web';
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  /** One-line summary shown before execution. */
  renderCall(args: Record<string, unknown>): string;
  renderResult(outcome: ToolOutcome): { ok: boolean; text: string };
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'end'; tokensPerSecond?: number };

export interface Provider {
  readonly name: string;
  readonly model: string;
  /** marks the *kind* shown in the badge (openai-compat / native / local) */
  readonly label: string;
  stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>;
  listModels?(): Promise<string[]>;
  health?(): Promise<string>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;

  constructor(message: string, provider: string, status?: number) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.status = status;
  }
}
/** Permission answers. */
export type PermissionAnswer = 'allow' | 'always' | 'deny';

export interface Settings {
  defaultProvider: string;
  model?: string;
  /** ask | acceptEdits | bypass */
  permissions: 'ask' | 'acceptEdits' | 'bypass';
  maxTurns: number;
  maxTokens: number;
  providers?: Record<
    string,
    { type: 'openai' | 'local'; apiBase?: string; apiKey?: string; model?: string }
  >;
  mcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  >;
  hooks?: Record<string, Array<{ matcher?: string; command: string; timeout?: number }>>;
  /** OpenAI-compatible reasoning_effort passthrough (e.g. "low"/"medium"/"high"). */
  reasoningEffort?: string;
  /** Extended thinking (Anthropic thinking blocks, Gemini thinkingBudget). */
  alwaysThinking?: boolean;
  maxThinkingTokens?: number;
  /** LSP servers (stdio) for the Diagnostics tool: name -> {command, extensions?}. */
  lspServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; extensions?: string[] }>;
}

export interface SessionEvent {
  type: 'user' | 'assistant' | 'tool_result' | 'summary';
  text?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  ok?: boolean;
  output?: string;
}

export const WORKDIR_IGNORES = new Set([
  '.git', '.hg', 'node_modules', '__pycache__', '.venv', 'venv', 'dist',
  'build', 'target', '.next', '.pytest_cache', '.ardan-output', 'coverage',
  '.mypy_cache', '.DS_Store', '.idea', '.vs', 'site-packages',
]);
