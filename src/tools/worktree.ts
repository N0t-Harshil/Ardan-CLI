// Worktree isolation tools (openclaude EnterWorktree / ExitWorktree).
// Creates an isolated git worktree under .ardan-worktrees/<name> and asks
// the REPL to switch the working context to it after the current turn.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ToolDef } from '../types.ts';

function git(workdir: string, args: string[], timeout = 60_000): { ok: boolean; output: string } {
  try {
    const output = execFileSync('git', args, {
      cwd: workdir,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, output: output.trim() };
  } catch (error) {
    const err = error as { message?: string; stderr?: string };
    return { ok: false, output: (err.stderr || err.message || 'git failed').trim().slice(0, 500) };
  }
}

export function isGitRepo(workdir: string): boolean {
  return git(workdir, ['rev-parse', '--is-inside-work-tree'], 10_000).ok;
}

export function enterWorktreeTool(): ToolDef {
  return {
    name: 'EnterWorktree',
    description:
      'Create an isolated git worktree (.ardan-worktrees/<name>, new branch with the same name) and continue the task there after this turn. Great for risky refactors and parallel experiments.',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worktree/branch name (default: ardan-<timestamp>).' },
      },
      required: [],
    },
    async run(args, ctx): Promise<ToolOutcome> {
      if (!isGitRepo(ctx.workdir)) {
        return { ok: false, output: 'not a git repository - worktrees need git' };
      }
      const name = (String(args.name || '')
        .trim()
        .replace(/[^\w.-]+/g, '-') || `ardan-${Date.now().toString(36)}`).slice(0, 40);
      const root = path.join(ctx.workdir, '.ardan-worktrees');
      const target = path.join(root, name);
      if (!ctx.state.get('baseWorkdir')) {
        ctx.state.set('baseWorkdir', ctx.workdir);
      }
      const created = git(ctx.workdir, ['worktree', 'add', target, '-b', name]);
      if (!created.ok && !created.output.includes('already exists')) {
        return { ok: false, output: `git worktree add failed: ${created.output}` };
      }
      ctx.state.set('worktreeTarget', target);
      ctx.state.set('workdirRequested', target);
      return {
        ok: true,
        output:
          `Worktree ready: ${target} (branch ${name}). ` +
          'The working directory switches there after this turn.',
      };
    },
    renderCall(args) {
      return `EnterWorktree(${String(args.name || 'auto')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.slice(0, 140) };
    },
  };
}

export function exitWorktreeTool(): ToolDef {
  return {
    name: 'ExitWorktree',
    description:
      'Leave the current worktree: switch back to the original project directory; optionally remove the worktree and its branch.',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        remove: { type: 'boolean', description: 'Also delete the worktree folder (default false).' },
      },
      required: [],
    },
    async run(args, ctx): Promise<ToolOutcome> {
      const current = ctx.state.get('worktreeTarget') as string | undefined;
      const base = (ctx.state.get('baseWorkdir') as string) || ctx.workdir;
      ctx.state.set('workdirRequested', base);
      let extra = '';
      if (args.remove && current) {
        const removed = git(base, ['worktree', 'remove', current, '--force']);
        extra = removed.ok
          ? ` Worktree ${current} removed.`
          : ` Worktree removal failed: ${removed.output}`;
      }
      return {
        ok: true,
        output: `Returning to ${base}.${extra} Applies after this turn.`,
      };
    },
    renderCall() {
      return 'ExitWorktree()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.slice(0, 140) };
    },
  };
}
