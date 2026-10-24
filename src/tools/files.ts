// File tools: Read / Write / Edit / ListDir (relative to the workdir).
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDef, ToolOutcome } from '../types.ts';

const MAX_LINE = 2000;
const MAX_BYTES = 256 * 1024;

function resolveInWorkdir(ctx: ToolContext, raw: string): string {
  const p = String(raw || '');
  if (!p) return p;
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(ctx.workdir, p);
}

export interface FileCheckpoint {
  /** User-turn index the edit happened in (0 = session start). */
  turn: number;
  file: string;
  /** Content BEFORE the edit (null = the file did not exist). */
  content: string | null;
}

/** Record pre-edit content per file per turn (for /rewind files). */
export function captureFileHistory(ctx: ToolContext, file: string): void {
  const registry = (ctx.state.get('fileHistory') as FileCheckpoint[]) ||
    ctx.state.set('fileHistory', [] as FileCheckpoint[]).get('fileHistory');
  const history = registry as FileCheckpoint[];
  const turn = Number(ctx.state.get('turnIndex') || 0);
  const last = [...history].reverse().find((entry) => entry.file === file);
  try {
    const content = fs.readFileSync(file, 'utf8');
    if (last && last.content === content) return; // no change since last capture
    history.push({ turn, file, content });
  } catch {
    if (last && last.content === null) return;
    history.push({ turn, file, content: null }); // file did not exist before
  }
}

function applyRestore(
  ctx: ToolContext,
  targets: Map<string, string | null>,
): string[] {
  if (!targets.size) return [];
  const restored: string[] = [];
  for (const [file, content] of targets) {
    try {
      if (content === null) {
        fs.rmSync(file, { force: true });
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
      }
      restored.push(path.relative(ctx.workdir, file) || file);
    } catch {
      /* best-effort */
    }
  }
  return restored;
}

/** Restore every tracked file to its earliest recorded (session-start) state. */
export function restoreFileHistory(ctx: ToolContext): string[] {
  const history = (ctx.state.get('fileHistory') as FileCheckpoint[] | undefined) || [];
  const earliest = new Map<string, string | null>();
  for (const entry of history) {
    if (!earliest.has(entry.file)) earliest.set(entry.file, entry.content);
  }
  return applyRestore(ctx, earliest);
}

/**
 * Restore files touched in turns > maxTurn to their state at the start of the
 * first turn being rolled back (state as of the end of turn maxTurn).
 */
export function restoreFileHistoryAt(ctx: ToolContext, maxTurn: number): string[] {
  const history = (ctx.state.get('fileHistory') as FileCheckpoint[] | undefined) || [];
  const firstAfter = new Map<string, string | null>();
  for (const entry of history) {
    if (entry.turn <= maxTurn) continue;
    if (!firstAfter.has(entry.file)) firstAfter.set(entry.file, entry.content);
  }
  return applyRestore(ctx, firstAfter);
}

export function mrkdwnEscape(text: string): string {
  return text;
}

export function readTool(): ToolDef {
  return {
    name: 'Read',
    description:
      'Read a text file. Returns content with line numbers. Optionally start at an offset for large files.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file (absolute or relative to cwd).' },
        offset: { type: 'number', description: 'Line to start from (default 1).' },
        limit: { type: 'number', description: 'Number of lines (default 2000).' },
      },
      required: ['file_path'],
    },
    async run(args, ctx) {
      const file = resolveInWorkdir(ctx, String(args.file_path || ''));
      if (!args.file_path) return { ok: false, output: 'file_path is required' };
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_BYTES) {
          return { ok: false, output: `file too large (${stat.size} bytes > ${MAX_BYTES})` };
        }
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n');
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = Number(args.limit) || 2000;
        const start = offset - 1;
        const numbered = lines
          .slice(start, start + limit)
          .map((line, index) => {
            const clipped = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…' : line;
            return `${String(start + index + 1).padStart(6)}→${clipped}`;
          });
        const header = `${path.relative(ctx.workdir, file)} (${lines.length} lines)`;
        return { ok: true, output: `${header}\n${numbered.join('\n') || '(empty file)'}` };
      } catch (error) {
        return { ok: false, output: (error as Error).message };
      }
    },
    renderCall(args) {
      return `Read(${String(args.file_path || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.ok ? outcome.output.split('\n')[0] : outcome.output.slice(0, 200) };
    },
  };
}

function nameCollisionHint(dir: string, base: string): string {
  try {
    const entries = fs.readdirSync(dir).filter((entry) =>
      entry.toLowerCase().includes(base.toLowerCase().slice(0, 8)),
    );
    if (entries.length) return ` Nearby: ${entries.slice(0, 5).join(', ')}`;
  } catch {
    /* ignore */
  }
  return '';
}

export function writeTool(): ToolDef {
  return {
    name: 'Write',
    description: 'Write a complete file (overwrites). Parent directories are created automatically.',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['file_path', 'content'],
    },
    async run(args, ctx) {
      const file = resolveInWorkdir(ctx, String(args.file_path || ''));
      if (!args.file_path) return { ok: false, output: 'file_path is required' };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        captureFileHistory(ctx, file);
        let summary = '';
        if (fs.existsSync(file)) {
          const before = fs.readFileSync(file, 'utf8').length;
          summary = `overwrote ${file} (${before} → ${String(args.content || '').length} chars)`;
        } else {
          summary = `created ${file} (${String(args.content || '').length} chars)`;
        }
        fs.writeFileSync(file, String(args.content ?? ''), 'utf8');
        return { ok: true, output: summary };
      } catch (error) {
        return { ok: false, output: (error as Error).message };
      }
    },
    renderCall(args) {
      return `Write(${String(args.file_path || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };
}

export function editTool(): ToolDef {
  return {
    name: 'Edit',
    description:
      'Replace an exact string inside a file with new text. The old string must match exactly (including whitespace). Prefer Read first to see exact content.',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async run(args, ctx) {
      const file = resolveInWorkdir(ctx, String(args.file_path || ''));
      if (!args.file_path || typeof args.old_string !== 'string') {
        return { ok: false, output: 'file_path, old_string and new_string are required' };
      }
      if (args.old_string === args.new_string) {
        return { ok: false, output: 'old_string and new_string are identical' };
      }
      captureFileHistory(ctx, file);
      try {
        const before = fs.readFileSync(file, 'utf8');
        const oldString = String(args.old_string);
        const newString = String(args.new_string ?? '');
        if (!before.includes(oldString)) {
          const base = path.basename(file);
          return {
            ok: false,
            output: `old_string not found in ${file}.${nameCollisionHint(ctx.workdir, base)} Read the file first to match exact text.`,
          };
        }
        const count = before.split(oldString).length - 1;
        if (count > 1 && !args.replace_all) {
          return {
            ok: false,
            output: `old_string appears ${count} times; either add surrounding context to make it unique or set replace_all=true`,
          };
        }
        const after = args.replace_all ? before.split(oldString).join(newString) : before.replace(oldString, newString);
        fs.writeFileSync(file, after, 'utf8');
        return { ok: true, output: `edited ${file} (replaced ${args.replace_all ? count : 1} occurrence(s))` };
      } catch (error) {
        return { ok: false, output: (error as Error).message };
      }
    },
    renderCall(args) {
      return `Edit(${String(args.file_path || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };
}

export function listDirTool(): ToolDef {
  return {
    name: 'ListDir',
    description: 'List files in a directory (one level), with sizes. Use Glob for pattern searches.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory path (default: cwd).' },
      },
      required: [],
    },
    async run(args, ctx) {
      const dir = args.directory ? resolveInWorkdir(ctx, String(args.directory)) : ctx.workdir;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const lines = entries
          .slice(0, 500)
          .map((entry) => {
            if (entry.isDirectory()) return `${entry.name}/`;
            try {
              const size = fs.statSync(path.join(dir, entry.name)).size;
              return `${entry.name} (${size}b)`;
            } catch {
              return entry.name;
            }
          })
          .sort((a, b) => (b.endsWith('/') ? 1 : 0) - (a.endsWith('/') ? 1 : 0));
        return { ok: true, output: `${dir}\n${lines.join('\n')}` || 'empty' };
      } catch (error) {
        return { ok: false, output: (error as Error).message };
      }
    },
    renderCall(args) {
      return `ListDir(${String(args.directory || '.')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: `listed ${outcome.output.split('\n').length - 1} entries` };
    },
  };
}
