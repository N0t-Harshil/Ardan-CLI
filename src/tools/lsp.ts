// Diagnostics tool - minimal stdio LSP client that opens a file and
// collects `textDocument/publishDiagnostics` from a configured language
// server (openclaude LSPTool, diagnostics subset). Servers live in
// settings.json under "lspServers":
//   "lspServers": {
//     "typescript-language-server": {
//       "command": "typescript-language-server", "args": ["--stdio"],
//       "extensions": [".ts", ".tsx", ".js", ".mjs"]
//     }
//   }
// One-shot client per call: initialize -> initialized -> didOpen ->
// collect publishDiagnostics up to a deadline -> shutdown/exit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolContext, ToolDef, ToolOutcome } from '../types.ts';

export interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  extensions?: string[];
}

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript',
  '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python',
  '.json': 'json', '.md': 'markdown', '.rs': 'rust', '.go': 'go',
  '.rb': 'ruby', '.java': 'java', '.cs': 'csharp', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html',
  '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shellscript',
  '.bash': 'shellscript', '.ps1': 'powershell', '.php': 'php',
  '.swift': 'swift', '.kt': 'kotlin', '.sql': 'sql', '.vue': 'vue',
  '.zig': 'zig', '.dart': 'dart', '.lua': 'lua', '.pl': 'perl',
};

const SEVERITY = ['', 'error', 'warning', 'info', 'hint'];

interface LspDiagnostic {
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  message?: string;
  severity?: number;
  source?: string;
  code?: string | number;
}

/** Server whose `extensions` list matches the file; else the first known server. */
export function pickServer(
  servers: Array<{ name: string; config: LspServerConfig }>,
  file: string,
): { name: string; config: LspServerConfig } | null {
  const ext = path.extname(file).toLowerCase();
  let fallback: { name: string; config: LspServerConfig } | null = null;
  for (const entry of servers) {
    if (!entry?.config?.command) continue;
    if (!fallback) fallback = entry;
    const exts = entry.config.extensions || [];
    if (exts.length && exts.some((value) => value.toLowerCase() === ext)) return entry;
  }
  return fallback;
}

function formatDiagnostic(
  diag: LspDiagnostic,
  display: string,
): string {
  const line = (diag.range?.start?.line ?? 0) + 1;
  const col = (diag.range?.start?.character ?? 0) + 1;
  const severity = SEVERITY[diag.severity ?? 1] || 'error';
  const source = diag.source ? ` (${diag.source})` : '';
  return `${display}:${line}:${col} [${severity}] ${diag.message ?? '(no message)'}${source}`;
}

function normalizedUri(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * Spawn the server, complete the LSP handshake for `filePath`, and collect
 * publishDiagnostics notifications until the deadline. Resolves even without
 * diagnostics (timeouts are normal for clean files); never throws.
 */
async function collectDiagnostics(
  server: { name: string; config: LspServerConfig },
  filePath: string,
  workdir: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  const text = fs.readFileSync(filePath, 'utf8');
  const languageId = LANGUAGE_IDS[path.extname(filePath).toLowerCase()] || 'plaintext';
  const uri = pathToFileURL(filePath).href;

  return await new Promise<string[]>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(server.config.command, server.config.args || [], {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...(server.config.env || {}) },
      });
    } catch (error) {
      resolve([`failed to start LSP server '${server.name}': ${error instanceof Error ? error.message : String(error)}`]);
      return;
    }

    const diagnostics = new Map<string, string[]>();
    let initReply: (() => void) | null = null;
    let buffer = Buffer.alloc(0);
    let finished = false;

    const cleanup = (result: string[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      signal.removeEventListener('abort', abortHandler);
      child.stdout?.removeAllListeners();
      try {
        child.kill();
      } catch {
        /* leave */
      }
      killTree(child.pid as number);
      initReply?.();
      resolve(result);
    };

    const abortHandler = () => cleanup([]);
    signal.addEventListener('abort', abortHandler, { once: true });

    const sendMessage = (payload: unknown) => {
      const body = JSON.stringify(payload);
      const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      try {
        child.stdin?.write(frame);
      } catch {
        /* server gone; deadline resolves */
      }
    };

    const deadlineTimer = setTimeout(() => {
      const lines: string[] = [];
      for (const entry of diagnostics.values()) lines.push(...entry);
      cleanup(lines.length ? lines : []);
    }, timeoutMs);

    child.stderr?.on('data', () => { /* servers chirp here; ignore */ });
    child.on('error', (error) => {
      cleanup([`failed to start LSP server '${server.name}' (${server.config.command}): ${error.message}`]);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const sep = buffer.indexOf('\r\n\r\n');
        if (sep === -1) break;
        const header = buffer.subarray(0, sep).toString('latin1');
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          buffer = buffer.subarray(sep + 4);
          continue;
        }
        const bodyStart = sep + 4;
        const bodyLen = Number(match[1]);
        if (buffer.length < bodyStart + bodyLen) break;
        const body = buffer.subarray(bodyStart, bodyStart + bodyLen).toString('utf8');
        buffer = buffer.subarray(bodyStart + bodyLen);
        let message: { id?: number; method?: string; params?: { uri?: string; diagnostics?: LspDiagnostic[] } };
        try {
          message = JSON.parse(body);
        } catch {
          continue;
        }
        if (typeof message.id === 'number' && message.method === undefined) {
          // response to initialize
          initReply?.();
        }
        if (message.method === 'textDocument/publishDiagnostics') {
          const docUri = message.params?.uri || '';
          const target = normalizedUri(uri);
          if (normalizedUri(docUri) !== target) continue; // other files
          const display = path.relative(workdir, filePath) || filePath;
          const lines = (message.params?.diagnostics || [])
            .filter((diag) => diag && typeof diag.message === 'string')
            .map((diag) => formatDiagnostic(diag, display));
          diagnostics.set(docUri, lines);
        }
      }
    });

    // LSP handshake
    sendMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(workdir + path.sep).href.replace(/\/$/, ''),
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
      },
    });
    initReply = () => {
      initReply = null;
      sendMessage({ jsonrpc: '2.0', method: 'initialized', params: {} });
      sendMessage({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId,
            version: 1,
            text,
          },
        },
      });
    };
  });
}

const SETTINGS_HINT =
  'No LSP servers configured. Add to settings.json, e.g. "lspServers": ' +
  '{ "typescript-language-server": { "command": "typescript-language-server", ' +
  '"args": ["--stdio"], "extensions": [".ts", ".tsx", ".js"] } }';

export function diagnosticsTool(
  servers: Array<{ name: string; config: LspServerConfig }>,
): ToolDef {
  return {
    name: 'Diagnostics',
    description:
      'Get LSP diagnostics (type errors, lint findings) for a source file from a ' +
      'configured language server. Prefer this over reading files or running ' +
      'compilers when you need to check whether edits compile cleanly.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File to diagnose (absolute or relative to the working directory).',
        },
        timeout: {
          type: 'number',
          description: 'Seconds to wait for diagnostics (default 4).',
        },
      },
      required: ['file_path'],
    },
    async run(args, ctx): Promise<ToolOutcome> {
      if (!servers.length) return { ok: false, output: SETTINGS_HINT };
      const raw = String(args.file_path || '').trim();
      if (!raw) return { ok: false, output: 'file_path is required' };
      const filePath = path.isAbsolute(raw) ? raw : path.resolve(ctx.workdir, raw);
      if (!fs.existsSync(filePath)) return { ok: false, output: `file not found: ${filePath}` };
      const server = pickServer(servers, filePath);
      if (!server) return { ok: false, output: SETTINGS_HINT };
      const timeoutMs = Math.min(Math.max(Number(args.timeout) || 4, 1), 30) * 1000;
      try {
        const lines = await collectDiagnostics(server, filePath, ctx.workdir, timeoutMs, ctx.signal);
        const display = path.relative(ctx.workdir, filePath) || filePath;
        if (!lines.length) {
          return { ok: true, output: `${display}: no diagnostics from ${server.name} (clean, or server reports nothing within ${timeoutMs / 1000}s).` };
        }
        return { ok: true, output: `${display} — ${lines.length} diagnostic(s) via ${server.name}:\n${lines.join('\n')}` };
      } catch (error) {
        return { ok: false, output: `diagnostics failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    renderCall(args) {
      return `Diagnostics(${String(args.file_path || '').slice(0, 80)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n')[0].slice(0, 170) };
    },
  };
}
