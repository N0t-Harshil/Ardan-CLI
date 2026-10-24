// Glob & Grep - dependency-free implementations.
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDef } from '../types.ts';
import { WORKDIR_IGNORES } from '../types.ts';

/** Limited glob: supports **, *, ? and literal segments, relative to root or absolute. */
export function globToRegExp(pattern: string): RegExp {
  let escaped = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        escaped += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        escaped += '[^/\\\\]*';
      }
    } else if (char === '?') {
      escaped += '[^/\\\\]';
    } else if (char === '.') {
      escaped += '\\.';
    } else {
      escaped += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${escaped}$`);
}

function walk(root: string, onFile: (file: string) => void, maxTotal = 20_000): void {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < maxTotal) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxTotal) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WORKDIR_IGNORES.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else {
        seen++;
        onFile(full);
      }
    }
  }
}

export function globTool(): ToolDef {
  return {
    name: 'Glob',
    description: 'Find files matching a glob pattern (e.g. "src/**/*.ts", "*.py"). Skips node_modules/.git etc.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const pattern = String(args.pattern || '');
      if (!pattern) return { ok: false, output: 'pattern is required' };
      const matcher = globToRegExp(pattern);
      const matches: string[] = [];
      walk(ctx.workdir, (file) => {
        const rel = path.relative(ctx.workdir, file).replace(/\\/g, '/');
        if (matcher.test(rel) || matcher.test(path.basename(file))) {
          matches.push(rel);
        }
      });
      matches.sort();
      if (!matches.length) return { ok: true, output: `no matches for ${pattern}` };
      return {
        ok: true,
        output: matches.slice(0, 300).join('\n') + (matches.length > 300 ? `\n...(${matches.length} total)` : ''),
      };
    },
    renderCall(args) {
      return `Glob(${String(args.pattern || '')})`;
    },
    renderResult(outcome) {
      const lines = outcome.output.split('\n');
      return { ok: outcome.ok, text: outcome.ok ? `${lines.length} match(es): ${lines[0]}` : outcome.output };
    },
  };
}

export function grepTool(): ToolDef {
  return {
    name: 'Grep',
    description:
      'Search file contents for a regular expression. Returns file:line matches. Much faster than reading files one by one.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (POSIX-ish regex, JS syntax).' },
        path: { type: 'string', description: 'Optional subdirectory or file to search (default: whole cwd).' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const pattern = String(args.pattern || '');
      if (!pattern) return { ok: false, output: 'pattern is required' };
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, args.ignore_case ? 'i' : '');
      } catch (error) {
        return { ok: false, output: `bad regex: ${(error as Error).message}` };
      }
      const base = args.path ? path.resolve(ctx.workdir, String(args.path)) : ctx.workdir;
      const results: string[] = [];
      const binaryGuard = Buffer.from([0, 0, 0]);

      walk(base, (file) => {
        if (results.length >= 100) return;
        let content: Buffer;
        try {
          if (fs.statSync(file).size > 1024 * 1024) return;
          content = fs.readFileSync(file);
        } catch {
          return;
        }
        if (content.indexOf(binaryGuard, 0, binaryGuard.length) !== -1) return;
        const text = content.toString('utf8');
        const rel = path.relative(ctx.workdir, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (regex.test(lines[index])) {
            results.push(`${rel}:${index + 1}: ${lines[index].trim().slice(0, 180)}`);
            if (results.length >= 100) break;
          }
        }
      });
      if (!results.length) return { ok: true, output: `no matches for /${pattern}/ in ${args.path || '.'}` };
      return {
        ok: true,
        output: results.join('\n') + (results.length === 100 ? '\n... (truncated)' : ''),
      };
    },
    renderCall(args) {
      return `Grep(${String(args.path || '.')}, /${String(args.pattern || '').slice(0, 60)}/)`;
    },
    renderResult(outcome) {
      const lines = outcome.output.split('\n');
      return {
        ok: outcome.ok,
        text: outcome.ok
          ? `${lines.length} match(es): ${lines[0].slice(0, 150)}`
          : outcome.output,
      };
    },
  };
}
