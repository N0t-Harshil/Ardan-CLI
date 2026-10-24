// TaskOutput / TaskStop / Monitor: manage background tasks registered by
// Bash / PowerShell (openclaude task framework). Monitor additionally
// streams new stdout to the REPL poller line-by-line while running.
import type { ToolContext, ToolDef, ToolOutcome } from '../types.ts';
import { bgRegistry, defaultShell, killTree, spawnManagedTask, truncate, type BgTask } from './bash.ts';

const POLL_MS = 200;

export function bgStatus(task: BgTask): string {
  if (!task.done) return 'running';
  return task.code === 0 ? 'finished (exit 0)' : task.code === null ? 'terminated' : `finished (exit ${task.code})`;
}

export function bgOutput(task: BgTask): string {
  const combined = (task.stdout || '') + (task.stderr ? `\n[stderr] ${task.stderr}` : '');
  return truncate(combined.trim()) || '(no output yet)';
}

export function taskOutputTool(): ToolDef {
  return {
    name: 'TaskOutput',
    description:
      'Get the output of a background task (from Bash/PowerShell run_in_background). ' +
      'Blocks up to timeout seconds waiting for completion when block=true.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The background task id (e.g. b1).' },
        block: { type: 'boolean', description: 'Wait for completion (default true).' },
        timeout: { type: 'number', description: 'Seconds to wait when blocking (default 30).' },
      },
      required: ['task_id'],
    },
    async run(args, ctx): Promise<ToolOutcome> {
      const tasks = bgRegistry(ctx);
      const task = tasks.get(String(args.task_id || ''));
      if (!task) {
        const ids = [...tasks.keys()].join(', ') || '(none)';
        return { ok: false, output: `no background task '${args.task_id}'. Active/finished ids: ${ids}` };
      }
      const block = args.block !== false;
      const deadline = Date.now() + Math.min(Number(args.timeout) || 30, 120) * 1000;
      while (block && !task.done && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return {
        ok: true,
        output: `task ${task.id} — ${bgStatus(task)}\ncommand: ${task.command}\n${bgOutput(task)}`,
      };
    },
    renderCall(args) {
      return `TaskOutput(${String(args.task_id || '')})`;
    },
    renderResult(outcome) {
      const head = outcome.output.split('\n')[0];
      return { ok: outcome.ok, text: head.slice(0, 160) };
    },
  };
}

export function taskStopTool(): ToolDef {
  return {
    name: 'TaskStop',
    description: 'Kill a background task started with run_in_background.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The background task id.' } },
      required: ['task_id'],
    },
    async run(args, ctx) {
      const tasks = bgRegistry(ctx);
      const task = tasks.get(String(args.task_id || ''));
      if (!task) {
        const ids = [...tasks.keys()].join(', ') || '(none)';
        return { ok: false, output: `no background task '${args.task_id}'. Known ids: ${ids}` };
      }
      if (!task.done) {
        killTree(task.child.pid as number);
        task.done = true;
        task.code = null;
      }
      return {
        ok: true,
        output: `task ${task.id} stopped. Output so far:\n${bgOutput(task)}`,
      };
    },
    renderCall(args) {
      return `TaskStop(${String(args.task_id || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n')[0].slice(0, 160) };
    },
  };
}

export function monitorTool(): ToolDef {
  return {
    name: 'Monitor',
    description:
      'Run a long-lived command as a background monitor (log tail, dev server, ' +
      'watch mode, follower). Returns a task id immediately; every new block of ' +
      'stdout is reported to you automatically while it runs (default cap 30 min) ' +
      'and a completion notice is sent at the end. Read manually with TaskOutput.',
    permission: 'bash',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to stream output from.' },
        timeout: { type: 'number', description: 'Optional cap in seconds (default 1800).' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) return { ok: false, output: 'command is required' };
      const timeoutSec = Math.min(Number(args.timeout) || 1800, 7200);
      const { task } = spawnManagedTask({
        ...defaultShell(),
        command,
        ctx,
        timeoutSec,
        registerNow: true,
      });
      task.monitor = true;
      task.reported = 0;
      // Cap: kill the monitor at the deadline (task stays queryable after).
      const cap = setTimeout(() => {
        if (!task.done) killTree(task.child.pid as number);
      }, timeoutSec * 1000);
      if (typeof cap.unref === 'function') cap.unref();
      return {
        ok: true,
        output:
          `Monitoring (task ${task.id}): ${command}\n` +
          `New output is reported automatically as it appears; final status on completion. ` +
          `Read manually with TaskOutput (task_id: ${task.id}) or stop with TaskStop.`,
      };
    },
    renderCall(args) {
      return `Monitor(${String(args.command || '').slice(0, 70)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n')[0].slice(0, 160) };
    },
  };
}

/** Fresh stdout deltas from running Monitor tasks — the REPL poller feed. */
export function monitorNewData(ctx: ToolContext): Array<{ task: BgTask; delta: string }> {
  const tasks = bgRegistry(ctx);
  const out: Array<{ task: BgTask; delta: string }> = [];
  for (const task of tasks.values()) {
    if (!task.monitor || task.done) continue;
    const reported = task.reported ?? task.stdout.length;
    const delta = task.stdout.slice(reported);
    if (delta) {
      task.reported = task.stdout.length;
      out.push({ task, delta: delta.slice(-1200) });
    }
  }
  return out;
}

/** Snapshot of finished-but-unreported tasks for the REPL notifier. */
export function pendingBgNotifications(ctx: ToolContext): BgTask[] {
  const tasks = bgRegistry(ctx);
  const notified = (ctx.state.get('bgNotified') as Set<string>) ||
    ctx.state.set('bgNotified', new Set<string>()).get('bgNotified');
  const done = notified as Set<string>;
  const fresh: BgTask[] = [];
  for (const task of tasks.values()) {
    if (task.done && !done.has(task.id)) {
      done.add(task.id);
      fresh.push(task);
    }
  }
  return fresh;
}
