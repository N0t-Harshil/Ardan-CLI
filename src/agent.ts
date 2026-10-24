// The Ardan agent loop: stream -> tool calls -> results -> repeat.
// openclaude/Claude-Code style single loop with permission gates and
// context trimming.
import type {
  ChatMessage,
  Provider,
  StreamEvent,
  ToolCall,
  ToolContext,
  ToolDef,
  ToolOutcome,
} from './types.ts';
import { scanToolJson } from './utils/tooljson.ts';

export interface PermissionGate {
  (tool: ToolDef, args: Record<string, unknown>): Promise<boolean>;
}

export interface RenderEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'turn_start' | 'turn_end' | 'status' | 'error';
  text?: string;
  tool?: string;
  call?: string;
  ok?: boolean;
  result?: string;
  turn?: number;
  tokensPerSecond?: number;
}

export interface LoopOptions {
  provider: Provider;
  tools: ToolDef[];
  /** Running conversation (neutral), mutated in place. */
  history: ChatMessage[];
  input: string;
  workdir: string;
  maxTurns?: number;
  permissionGate: PermissionGate;
  onEvent: (event: RenderEvent) => void;
  onAssistantTurn?: (turn: { text: string; toolCalls: ToolCall[] }) => void;
  onToolResult?: (result: { call: ToolCall; outcome: ToolOutcome }) => void;
  signal?: AbortSignal;
  state?: Map<string, unknown>;
  /** entities appended per-loop (e.g. @file contents) */
  extraContextPrefix?: string;
}

const MAX_TOOL_OUTPUT = 30_000;
const COMPACT_BELOW = 140; // message count that triggers trims

export interface LoopResult {
  text: string;
  toolCallsUsed: number;
  aborted: boolean;
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    provider,
    tools,
    history,
    input,
    workdir,
    maxTurns = Number(process.env.ARDAN_MAX_TURNS || 30),
    permissionGate,
    onEvent,
    signal = new AbortController().signal,
  } = options;

  if (input) {
    history.push({
      role: 'user',
      content: options.extraContextPrefix ? `${options.extraContextPrefix}\n\n${input}` : input,
    });
  }

  const state: Map<string, unknown> = options.state || new Map();
  const ctx: ToolContext = { workdir, sessionId: 'inline', signal, state };

  let toolCallsUsed = 0;
  let aborted = false;
  const timing = {
    started: 0,
    streamedChars: 0,
    lastTokensPerSecond: 0,
  };

  for (let turn = 1; turn <= Math.max(1, maxTurns); turn++) {
    if (signal.aborted) {
      aborted = true;
      break;
    }

    maybeCompact(history);
    onEvent({ type: 'turn_start', turn });

    let assistantText = '';
    const calls: ToolCall[] = [];

    const signal2 = signal;
    timing.started = performance.now();
    timing.streamedChars = 0;

    try {
      for await (const event of provider.stream(
        buildLoopMessages(history, tools, options),
        options.tools,
        signal2,
      )) {
        const typed = event as StreamEvent;
        if (typed.type === 'text') {
          assistantText += typed.text;
          timing.streamedChars += typed.text.length;
          onEvent({ type: 'text', text: typed.text });
        } else if (typed.type === 'tool_call') {
          calls.push(typed.call);
        } else if (typed.type === 'end') {
          const duration = Math.max(0.25, (performance.now() - timing.started) / 1000);
          timing.lastTokensPerSecond = typed.tokensPerSecond || Math.round((timing.streamedChars / 4) / duration);
          onEvent({ type: 'status', tokensPerSecond: timing.lastTokensPerSecond });
        }
      }
    } catch (error) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      onEvent({
        type: 'error',
        text: `${provider.name}: ${(error as Error).message}`,
      });
      return {
        text: assistantText || '',
        toolCallsUsed,
        aborted,
      };
    }

    let finalText = assistantText;
    if (!calls.length) {
      // Fallback: models without native tool-calling emit tool JSON as text.
      const scan = scanToolJson(
        finalText,
        options.tools.map((tool) => tool.name),
      );
      if (scan.calls.length) {
        calls.push(...scan.calls);
        finalText = scan.cleanedText;
        onEvent({ type: 'text', text: '\n' });
      }
    }

    history.push({
      role: 'assistant',
      content: finalText,
      toolCalls: calls.length ? calls : undefined,
    });
    options.onAssistantTurn?.({ text: finalText, toolCalls: calls });
    onEvent({ type: 'turn_end', turn });

    if (!calls.length) {
      return { text: finalText, toolCallsUsed, aborted };
    }

    for (const call of calls) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      const tool = options.tools.find((t) => t.name === call.name);
      toolCallsUsed++;
      onEvent({ type: 'tool_call', tool: call.name, call: tool ? tool.renderCall(call.args) : JSON.stringify(call.args).slice(0, 90) });

      let outcome: ToolOutcome;
      if (!tool) {
        outcome = {
          ok: false,
          output: `Unknown tool "${call.name}". Available: ${options.tools.map((t) => t.name).join(', ')}`,
        };
      } else {
        const allowed = await permissionGate(tool, call.args);
        if (!allowed) {
          outcome = { ok: false, output: 'The user denied permission for this tool call. Stop asking for it; proceed differently or finish with what you have.' };
        } else {
          try {
            outcome = await tool.run(call.args, ctx);
          } catch (error) {
            outcome = { ok: false, output: `tool error: ${(error as Error).message}` };
          }
        }
      }

      const rendered = tool ? tool.renderResult(outcome) : { ok: false, text: outcome.output.slice(0, 150) };
      onEvent({
        type: 'tool_result',
        ok: rendered.ok,
        result: rendered.text,
        tool: call.name,
      });

      const clipped =
        outcome.output.length > MAX_TOOL_OUTPUT
          ? `${outcome.output.slice(0, MAX_TOOL_OUTPUT)}\n...[clipped]`
          : outcome.output;
      history.push({
        role: 'tool',
        toolCallId: call.id,
        content: `(${outcome.ok ? 'OK' : 'ERROR'}) ${clipped}`,
      });
      options.onToolResult?.({ call, outcome });
    }

    if (aborted) break;
  }

  return { text: '', toolCallsUsed, aborted };
}

/* ------------------------------------------------------------ helpers */

function buildLoopMessages(
  history: ChatMessage[],
  tools: ToolDef[],
  options: LoopOptions,
): ChatMessage[] {
  // Providers expect the system prompt first; history already contains it.
  void tools;
  void options;
  return history;
}

/**
 * Crude context guard: when neutral history gets very long, drop the
 * oldest non-system, non-recent messages and note the trim.
 */
function maybeCompact(history: ChatMessage[]): void {
  if (history.length < COMPACT_BELOW) return;
  const system = history.filter((m) => m.role === 'system');
  const recent = history.slice(-40);
  history.length = 0;
  history.push(
    ...system,
    {
      role: 'user',
      content: '[older conversation trimmed to fit the context window; continue with the latest task]',
    },
    ...recent.slice(1),
  );
}

export function systemPrompt(options: {
  workdir: string;
  providerLabel: string;
  tools: ToolDef[];
  planMode: boolean;
  memory?: string;
  agentsSummary?: string;
  skillsSummary?: string;
  outputStyle?: string;
}): string {
  const platformNote =
    process.platform === 'win32'
      ? 'The OS is Windows. Shell commands run through cmd.exe. Use dir, never ls, in Bash. Prefer node -e for scripting.'
      : 'The OS is POSIX. Bash runs commands with bash -c.';
  const toolLines = options.tools.map((tool) => `  - ${tool.name}: ${tool.description}`).join('\n');
  const memoryBlock = options.memory
    ? `\n\nPROJECT MEMORY (ARDAN.md):\n${options.memory.slice(0, 6000)}`
    : '';
  const planBlock = options.planMode
    ? '\n\nYou are in PLAN MODE. Research with the read-only tools, ask the user questions when requirements are ambiguous (AskUserQuestion), then present a numbered implementation plan as your final response and call ExitPlanMode. Write tools are hidden while planning.'
    : '\n\nFor larger or ambiguous tasks, consider EnterPlanMode first; present a plan, get approval, then implement.';
  const agentsBlock = options.agentsSummary
    ? `\n\nCUSTOM SUBAGENTS - delegate with the Task tool's "subagent" argument:\n${options.agentsSummary}`
    : '';
  const skillsBlock = options.skillsSummary
    ? `\n\nSKILLS - load playbook instructions with the Skill tool when a listed domain matches the task:\n${options.skillsSummary}`
    : '';
  const styleBlock = options.outputStyle ? `\n\n${options.outputStyle}` : '';
  return `You are Ardan, an expert coding agent inside the terminal at: ${options.workdir}

Today: ${new Date().toDateString()}. Provider: ${options.providerLabel}.
${platformNote}

RESPONSIBILITIES
- Work step by step. Use the tools to read, inspect, write, edit, run and verify.
- Prefer Grep/Glob/RepoMap/Read over Bash for exploration.
- Edit files with exact-match Edit; Write only for new files or full rewrites.
- Track multi-step work with TaskCreate/TaskUpdate instead of guessing.
- Never invent tool results. If something fails, observe the error and adapt.
- Final responses: concise, no tool chatter, code fences for code.

AVAILABLE TOOLS
${toolLines}${planBlock}${agentsBlock}${skillsBlock}${styleBlock}${memoryBlock}`;
}
