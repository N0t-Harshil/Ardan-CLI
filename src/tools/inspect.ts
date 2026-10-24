// Inspection tools: RepoMap, NodeRepl (persistent JS sandbox), NotebookEdit,
// CtxInspect, ListMcpResources.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import type { ChatMessage, ToolContext, ToolDef, ToolOutcome } from '../types.ts';
import { WORKDIR_IGNORES } from '../types.ts';

/* ------------------------------------------------------------ RepoMap */

export function repoMapTool(): ToolDef {
  return {
    name: 'RepoMap',
    description:
      'Compact structural map of the project: directories with file counts, top files with sizes. Read this before exploring large unknown repos.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional subdirectory to map (default: cwd).' },
        depth: { type: 'number', description: 'Max tree depth (default 3).' },
      },
      required: [],
    },
    async run(args, ctx): Promise<ToolOutcome> {
      const base = args.path ? path.resolve(ctx.workdir, String(args.path)) : ctx.workdir;
      const maxDepth = Math.min(Number(args.depth) || 3, 6);
      const lines: string[] = [];
      const label = path.relative(ctx.workdir, base) || '.';

      const mapDir = (dir: string, depth: number): void => {
        if (lines.length >= 180) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        const dirs = entries.filter(
          (e) => e.isDirectory() && !WORKDIR_IGNORES.has(e.name) && !e.name.startsWith('.'),
        );
        const files = entries.filter((e) => e.isFile());
        let totalBytes = 0;
        for (const file of files) {
          try {
            totalBytes += fs.statSync(path.join(dir, file.name)).size;
          } catch {
            /* racy file */
          }
        }
        const display = depth === 0 ? label : path.relative(base, dir).replace(/\\/g, '/') || '.';
        lines.push(
          `${'  '.repeat(depth)}${display}/  ${dim_count(files.length)} files, ${humanBytes(totalBytes)}`,
        );
        if (depth < maxDepth) {
          for (const file of files.slice(0, 14)) {
            try {
              const size = fs.statSync(path.join(dir, file.name)).size;
              lines.push(`${'  '.repeat(depth + 2)}${file.name}  (${humanBytes(size)})`);
            } catch {
              /* skip */
            }
          }
          for (const d of dirs.slice(0, 20)) {
            mapDir(path.join(dir, d.name), depth + 1);
          }
          if (dirs.length > 20) lines.push(`${'  '.repeat(depth + 2)}... +${dirs.length - 20} more dirs`);
        }
      };

      try {
        fs.statSync(base);
      } catch {
        return { ok: false, output: `no such path: ${base}` };
      }
      mapDir(base, 0);
      return { ok: true, output: lines.join('\n') };
    },
    renderCall(args) {
      return `RepoMap(${String(args.path || '.')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: `${outcome.output.split('\n').length} lines mapped` };
    },
  };
}

function dim_count(n: number): string {
  return String(n);
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size}b`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}kb`;
  return `${(size / (1024 * 1024)).toFixed(1)}mb`;
}

/* ------------------------------------------------------------ NodeRepl */

interface ReplState {
  context?: vm.Context;
  logs: string[];
}

/** Persistent JS evaluation sandbox (openclaude REPLTool equivalent). */
export function nodeReplTool(): ToolDef {
  return {
    name: 'NodeRepl',
    description:
      'Evaluate JavaScript in a persistent Node sandbox and inspect the result. State (variables) survives between calls. Great for quick data checks, calculations, JSON experiments. Full node APIs via require().',
    permission: 'bash',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript to evaluate.' } },
      required: ['code'],
    },
    async run(args, ctx) {
      const code = String(args.code || '');
      if (!code.trim()) return { ok: false, output: 'code is required' };
      const store =
        (ctx.state.get('nodeRepl') as ReplState) || { context: undefined, logs: [] };
      ctx.state.set('nodeRepl', store);
      if (!store.context) {
        store.logs = [];
        const requireShim = createRequire(path.join(ctx.workdir, '_repl_.js'));
        store.context = vm.createContext({
          console: {
            log: (...parts: unknown[]) => store.logs.push(parts.map((p) => String(p)).join(' ')),
            error: (...parts: unknown[]) => store.logs.push(`ERR ${parts.map((p) => String(p)).join(' ')}`),
            warn: (...parts: unknown[]) => store.logs.push(`WARN ${parts.map((p) => String(p)).join(' ')}`),
          },
          require: requireShim,
          process,
          Buffer,
          setTimeout,
          clearTimeout,
          result: undefined,
        });
      }
      const logs = store.logs;
      try {
        const completion = vm.runInContext(code, store.context, { timeout: 5000 });
        store.context.result = completion;
        const inspected = util.inspect(completion, { depth: 2, breakLength: 120 });
        const output = logs.length ? `${logs.join('\n')}\n=> ${inspected}` : `=> ${inspected}`;
        return { ok: true, output: output.slice(0, 8000) };
      } catch (error) {
        const err = error as Error;
        return { ok: false, output: `${err.name}: ${err.message}` };
      }
    },
    renderCall(args) {
      return `NodeRepl(${String(args.code || '').replace(/\s+/g, ' ').slice(0, 70)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n').slice(-1)[0].slice(0, 160) };
    },
  };
}

/* -------------------------------------------------------- NotebookEdit */

function toSourceLines(source: string): string[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

export function notebookEditTool(): ToolDef {
  return {
    name: 'NotebookEdit',
    description:
      'Edit a Jupyter notebook (.ipynb): replace a cell, insert a new cell after an index, or delete one.',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        cell: { type: 'number', description: 'Cell index to modify/delete.' },
        new_source: { type: 'string', description: 'New cell source.' },
        insert_after: { type: 'number', description: 'Insert a new cell after this index instead of replacing.' },
        cell_type: { type: 'string', description: 'code | markdown (for inserts).' },
        delete: { type: 'boolean', description: 'Delete the cell at index instead.' },
      },
      required: ['notebook_path'],
    },
    async run(args, ctx) {
      const notebook = path.isAbsolute(String(args.notebook_path || ''))
        ? path.resolve(String(args.notebook_path))
        : path.resolve(ctx.workdir, String(args.notebook_path || ''));
      try {
        const parsed = JSON.parse(fs.readFileSync(notebook, 'utf8'));
        const cells: Array<Record<string, unknown>> = parsed.cells || [];
        const cellType = String(args.cell_type || 'code');
        if (args.insert_after !== undefined) {
          cells.splice(Number(args.insert_after) + 1, 0, {
            cell_type: cellType === 'markdown' ? 'markdown' : 'code',
            source: toSourceLines(String(args.new_source ?? '')),
            metadata: {},
            outputs: [],
            execution_count: null,
          });
        } else if (args.delete) {
          cells.splice(Number(args.cell), 1);
        } else {
          const index = Number(args.cell ?? 0);
          if (!cells[index]) return { ok: false, output: `no cell at index ${index}` };
          cells[index].source = toSourceLines(String(args.new_source ?? ''));
          cells[index].outputs = cellType === 'markdown' ? [] : cells[index].outputs ?? [];
        }
        parsed.cells = cells;
        fs.writeFileSync(notebook, JSON.stringify(parsed, null, 1));
        return { ok: true, output: `notebook updated (${cells.length} cells): ${notebook}` };
      } catch (error) {
        return { ok: false, output: (error as Error).message };
      }
    },
    renderCall(args) {
      return `NotebookEdit(${String(args.notebook_path || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };
}

/* ---------------------------------------------------------- CtxInspect */

export function ctxInspectTool(): ToolDef {
  return {
    name: 'CtxInspect',
    description: 'Inspect the current conversation context: message counts, estimated token usage.',
    permission: 'auto',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(_args, ctx) {
      const history = (ctx.state.get('historyRef') as ChatMessage[]) || [];
      let chars = 0;
      const byRole: Record<string, number> = {};
      for (const message of history) {
        byRole[message.role] = (byRole[message.role] || 0) + 1;
        chars += message.content.length;
      }
      const toolNames = (ctx.state.get('toolNames') as string[]) || [];
      const estimate = Math.round(chars / 4);
      return {
        ok: true,
        output: [
          `messages: ${history.length}  (${Object.entries(byRole).map(([role, count]) => `${role}:${count}`).join(', ')})`,
          `characters: ${chars}  ~tokens: ${estimate}`,
          `tools in catalog: ${toolNames.length}`,
        ].join('\n'),
      };
    },
    renderCall() {
      return 'CtxInspect()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n')[0] };
    },
  };
}

/* -------------------------------------------------- ListMcpResources */

export function listMcpResourcesTool(mcpServers: Array<{ serverName: string; request: (method: string, params: Record<string, unknown>) => Promise<unknown> }>): ToolDef {
  return {
    name: 'ListMcpResources',
    description: 'List resources exposed by connected MCP servers.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional server name filter.' },
      },
      required: [],
    },
    async run(args) {
      const filter = args.server ? String(args.server).toLowerCase() : undefined;
      const lines: string[] = [];
      for (const server of mcpServers) {
        if (filter && server.serverName.toLowerCase() !== filter) continue;
        let listed: any = null;
        try {
          listed = await server.request('resources/list', {});
        } catch {
          /* server without resources */
        }
        const resources = listed?.resources || [];
        if (!resources.length) {
          lines.push(`${server.serverName}: (no resources)`);
          continue;
        }
        for (const resource of resources.slice(0, 30)) {
          lines.push(`${server.serverName}: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}`);
        }
      }
      return { ok: true, output: lines.join('\n') || 'no MCP servers connected' };
    },
    renderCall() {
      return 'ListMcpResources()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: `${outcome.output.split('\n').filter(Boolean).length} resources` };
    },
  };
}

export function readMcpResourceTool(mcpServers: Array<{ serverName: string; request: (method: string, params: Record<string, unknown>) => Promise<unknown> }>): ToolDef {
  return {
    name: 'ReadMcpResource',
    description:
      'Read one resource from a connected MCP server by server name and URI. ' +
      'List available URIs first with ListMcpResources.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name.' },
        uri: { type: 'string', description: 'Resource URI (e.g. file:///...) ' },
      },
      required: ['server', 'uri'],
    },
    async run(args) {
      const serverName = String(args.server || '');
      const uri = String(args.uri || '');
      const server = mcpServers.find((s) => s.serverName.toLowerCase() === serverName.toLowerCase());
      if (!server) {
        return { ok: false, output: `unknown server '${serverName}'. connected: ${mcpServers.map((s) => s.serverName).join(', ') || '(none)'}` };
      }
      try {
        const read = await server.request('resources/read', { uri });
        const contents = read?.contents || [(read as any)?.content].filter(Boolean);
        const parts = contents.map((content: any) =>
          content.blob
            ? `[binary ${content.mimeType || 'blob'} uri=${content.uri}]`
            : content.text !== undefined
              ? content.text
              : `[unreadable content for ${content.uri || uri}]`,
        );
        return { ok: true, output: `[resource ${uri}]\n${parts.join('\n---\n')}` };
      } catch (error) {
        return { ok: false, output: `read failed: ${(error as Error).message.slice(0, 300)}` };
      }
    },
    renderCall(args) {
      return `ReadMcpResource(${String(args.server || '')} → ${String(args.uri || '').slice(0, 50)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.ok ? 'resource loaded' : outcome.output.slice(0, 140) };
    },
  };
}
