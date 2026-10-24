// Bash tool - shell passthrough with timeout, safe piping and
// auto-backgrounding. openclaude-style task framework: a still-running
// foreground command migrates into the background registry after a short
// budget; run_in_background registers immediately; TaskOutput/TaskStop and
// the Monitor tool build on the same registry.
import { spawn } from 'node:child_process';
import type { ToolContext, ToolDef, ToolOutcome } from '../types.ts';

const MAX_OUTPUT = 10_000;

/** Foreground commands still running after this long move to the background. */
export const AUTO_BG_SECONDS = 15;

export interface BgTask {
  id: string;
  command: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  done: boolean;
  code: number | null;
  started: number;
  /** Monitor tasks stream new stdout to the REPL poller while running. */
  monitor?: boolean;
  /** stdout length already reported for monitored tasks. */
  reported?: number;
  /** Set when a foreground command was auto-migrated to the background. */
  migrated?: boolean;
}

export function bgRegistry(ctx: ToolContext): Map<string, BgTask> {
  const existing = ctx.state.get('bgTasks') as Map<string, BgTask> | undefined;
  if (existing) return existing;
  const created = new Map<string, BgTask>();
  ctx.state.set('bgTasks', created);
  return created;
}

export function nextBgId(tasks: Map<string, BgTask>): string {
  let max = 0;
  for (const id of tasks.keys()) {
    const numeric = Number(id.replace(/^b/, ''));
    if (Number.isFinite(numeric)) max = Math.max(max, numeric);
  }
  return `b${max + 1}`;
}

export function spawnShell(
  shell: string,
  argsPrefix: string[],
  command: string,
  cwd: string,
): ReturnType<typeof spawn> {
  return spawn(shell, [...argsPrefix, command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: process.platform === 'win32',
  });
}

export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch {
      /* best-effort */
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* best-effort */
    }
  }
}

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.25));
  return `${head}\n...[output truncated, ${text.length - max} chars removed]...\n${tail}`;
}
export { truncate };

export interface ManagedSpawnOptions {
  shell: string;
  argsPrefix: string[];
  command: string;
  ctx: ToolContext;
  timeoutSec: number;
  /** Register immediately (run_in_background / Monitor); resolves the receipt at once. */
  registerNow?: boolean;
  /** Foreground: migrate into the registry after AUTO_BG_SECONDS if still running. */
  allowMigration?: boolean;
}

export interface ManagedTask {
  task: BgTask;
  /** Foreground callers await this; registered callers can ignore it. */
  wait: Promise<ToolOutcome>;
}

const BG_RECEIPT = (id: string, command: string): ToolOutcome => ({
  ok: true,
  output:
    `Command running in background with ID: ${id}\n` +
    `command: ${command}\n` +
    `Retrieve output with the TaskOutput tool (task_id: ${id}); kill it with TaskStop. ` +
    `It will also be reported to you when it finishes.`,
});

/**
 * Single engine for Bash / PowerShell / Monitor:
 * - registerNow: task registered immediately, receipt resolved at once,
 *   no timeout kill (own its cap externally).
 * - foreground with allowMigration: registers and reports a background
 *   receipt if the command still runs after AUTO_BG_SECONDS.
 * - plain foreground: buffered output, timeout kill, abort kill.
 */
export function spawnManagedTask(opts: ManagedSpawnOptions): ManagedTask {
  const { shell, argsPrefix, command, ctx, timeoutSec } = opts;
  const tasks = bgRegistry(ctx);
  const child = spawnShell(shell, argsPrefix, command, ctx.workdir);
  const id = nextBgId(tasks);
  const task: BgTask = {
    id,
    command,
    child,
    stdout: '',
    stderr: '',
    done: false,
    code: null,
    started: Date.now(),
  };
  if (opts.registerNow) tasks.set(id, task);

  let settled = false;
  let resolveWait!: (outcome: ToolOutcome) => void;
  const wait = new Promise<ToolOutcome>((resolve) => {
    resolveWait = resolve;
  });
  const settle = (outcome: ToolOutcome) => {
    if (settled) return;
    settled = true;
    resolveWait(outcome);
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    task.stdout = (task.stdout + chunk.toString()).slice(-MAX_OUTPUT * 2);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    task.stderr = (task.stderr + chunk.toString()).slice(-MAX_OUTPUT * 2);
  });

  const abortHandler = () => {
    killTree(child.pid as number);
  };
  if (!opts.registerNow) {
    ctx.signal.addEventListener('abort', abortHandler, { once: true });
  }

  // Hard timeout applies only while the originating call is still waiting.
  const killTimer = opts.registerNow
    ? null
    : setTimeout(() => {
        if (!settled) killTree(child.pid as number);
      }, timeoutSec * 1000);

  const migrateTimer =
    opts.allowMigration && !opts.registerNow
      ? setTimeout(() => {
          if (settled || ctx.signal.aborted) return;
          tasks.set(id, task);
          task.migrated = true;
          ctx.signal.removeEventListener('abort', abortHandler);
          if (killTimer) clearTimeout(killTimer);
          settle({
            ok: true,
            output:
              `Command still running after ${AUTO_BG_SECONDS}s — moved to background with ID ${id}.\n` +
              `Retrieve output with TaskOutput (task_id: ${id}); kill it with TaskStop. ` +
              `You will be notified when it finishes.`,
          });
        }, AUTO_BG_SECONDS * 1000)
      : null;

  child.on('error', (error) => {
    if (killTimer) clearTimeout(killTimer);
    if (migrateTimer) clearTimeout(migrateTimer);
    ctx.signal.removeEventListener('abort', abortHandler);
    task.done = true;
    task.code = -1;
    if (opts.registerNow || task.migrated) return;
    settle({ ok: false, output: `${error.message} (is the command on PATH?)` });
  });

  child.on('close', (code) => {
    if (killTimer) clearTimeout(killTimer);
    if (migrateTimer) clearTimeout(migrateTimer);
    ctx.signal.removeEventListener('abort', abortHandler);
    task.done = true;
    task.code = code;
    if (opts.registerNow || task.migrated) return; // TaskOutput/poller own it
    const combined = (task.stdout || '') + (task.stderr ? `\n[stderr] ${task.stderr}` : '');
    const killed = ctx.signal.aborted || code === null;
    settle({
      ok: code === 0 && !killed,
      output: killed
        ? truncate(combined) + '\n[command was interrupted/killed]'
        : truncate(combined) || `(exited with code ${code})`,
    });
  });

  if (opts.registerNow) settle(BG_RECEIPT(id, command));
  return { task, wait };
}

/** Default shell invocation pair for the current platform. */
export function defaultShell(): { shell: string; argsPrefix: string[] } {
  return process.platform === 'win32'
    ? { shell: 'cmd.exe', argsPrefix: ['/d', '/s', '/c'] }
    : { shell: 'bash', argsPrefix: ['-c'] };
}

export function bashTool(): ToolDef {
  const tool: ToolDef = {
    name: 'Bash',
    description:
      'Run a shell command in the working directory and get its output. ' +
      'Use for git, builds, package management, running scripts and tests. ' +
      'Avoid interactive commands. For long or blocking commands (dev servers, ' +
      'watchers, large installs, long sleeps) set run_in_background=true and ' +
      'poll with TaskOutput instead. Commands still running after 15 seconds ' +
      'automatically move to the background and return a task id.',
    permission: 'bash',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout: {
          type: 'number',
          description: 'Optional timeout in seconds (default 120).',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run without waiting; returns a task id for TaskOutput/TaskStop.',
        },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) return { ok: false, output: 'command is required' };
      const timeoutSec = Math.min(Number(args.timeout) || 120, 600);
      const { shell, argsPrefix } = defaultShell();
      const { wait } = spawnManagedTask({
        shell,
        argsPrefix,
        command,
        ctx,
        timeoutSec,
        registerNow: Boolean(args.run_in_background),
        allowMigration: true,
      });
      return await wait;
    },
    renderCall(args) {
      const bg = args.run_in_background ? ' [bg]' : '';
      return `Bash(${String(args.command || '').slice(0, 90)})${bg}`;
    },
    renderResult(outcome) {
      const firstLines = outcome.output.split('\n').slice(0, 4).join(' ⏎ ');
      return {
        ok: outcome.ok,
        text: firstLines.slice(0, 200),
      };
    },
  };
  return tool;
}

/* ------------------------------------------------------- PowerShell tool */

export function powershellTool(): ToolDef {
  return {
    name: 'PowerShell',
    description:
      'Run a Windows PowerShell command (powershell.exe -NoProfile -NonInteractive). ' +
      'Prefer for object-pipeline work with files, the registry or processes, or when shell syntax needs PowerShell. ' +
      'Avoid Read-Host (non-interactive). For long commands use run_in_background and TaskOutput; ' +
      'commands still running after 15 seconds move to the background automatically.',
    permission: 'bash',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell script to execute.' },
        timeout: { type: 'number', description: 'Optional timeout in seconds (default 120).' },
        run_in_background: { type: 'boolean', description: 'Run without waiting; returns a task id.' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) return { ok: false, output: 'command is required' };
      const timeoutSec = Math.min(Number(args.timeout) || 120, 600);
      const { wait } = spawnManagedTask({
        shell: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
        command,
        ctx,
        timeoutSec,
        registerNow: Boolean(args.run_in_background),
        allowMigration: true,
      });
      return await wait;
    },
    renderCall(args) {
      return `PowerShell(${String(args.command || '').slice(0, 90)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n')[0].slice(0, 180) };
    },
  };
}
