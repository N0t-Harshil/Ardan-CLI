// Hooks: settings-configured shell commands run at lifecycle events,
// openclaude-style. Supported events:
//   SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SessionEnd
//
// settings.json shape:
//   "hooks": {
//     "PreToolUse": [
//       { "matcher": "Bash|Write", "command": "guard.cmd", "timeout": 10 }
//     ]
//   }
// The hook receives a JSON payload on stdin: { event, tool, args, session,
// cwd }. Non-zero exit from PreToolUse BLOCKS the action (stdout becomes the
// denial reason); JSON stdout { "decision": "approve"|"block", "systemMessage":
// "..." } is honored when present.
import { spawn } from 'node:child_process';
import type { Settings } from '../types.ts';

export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionEnd';

export interface HookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface HookPayload {
  event: HookEvent;
  tool?: string;
  args?: unknown;
  session?: string;
  cwd?: string;
  prompt?: string;
}

export interface HookResult {
  blocked: boolean;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  output: string;
}

export function hooksFor(
  settings: Pick<Settings, 'hooks'>,
  event: HookEvent,
): HookEntry[] {
  const dict = settings.hooks || {};
  return dict[event] || [];
}

/** matcher is a regex-ish pipe list of tool names ("Bash|Write"); empty = all. */
export function hookMatches(entry: HookEntry, toolName?: string): boolean {
  if (!entry.matcher) return true;
  if (!toolName) return false;
  try {
    return new RegExp(`^(?:${entry.matcher})(?:$|__)`).test(toolName);
  } catch {
    return entry.matcher.split('|').includes(toolName);
  }
}

export async function runHook(
  entry: HookEntry,
  payload: HookPayload,
  workdir: string,
): Promise<HookResult> {
  return await new Promise<HookResult>((resolve) => {
    let child;
    try {
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
      const args =
        process.platform === 'win32'
          ? ['/d', '/s', '/c', entry.command]
          : ['-c', entry.command];
      child = spawn(shell, args, {
        cwd: workdir,
        env: {
          ...process.env,
          ARDAN_HOOK_EVENT: payload.event,
          ARDAN_HOOK_TOOL: payload.tool || '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
      });
    } catch (error) {
      resolve({ blocked: false, output: `hook spawn failed: ${(error as Error).message}` });
      return;
    }

    const timer = setTimeout(() => child.kill(), (entry.timeout || 20) * 1000);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ blocked: false, output: `hook error: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout.trim();
      let decision: 'approve' | 'block' | undefined;
      let systemMessage: string | undefined;
      if (output.startsWith('{')) {
        try {
          const parsed = JSON.parse(output);
          decision = parsed.decision;
          systemMessage = parsed.systemMessage;
        } catch {
          /* plain text output */
        }
      }
      resolve({
        blocked: code !== 0 || decision === 'block',
        decision,
        systemMessage,
        output,
      });
    });

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      /* stdin closed already */
    }
  });
}

export function describeHookBlock(result: HookResult): string {
  return result.systemMessage || result.output || 'Blocked by a PreToolUse hook.';
}
