// Minimal MCP stdio client (JSON-RPC 2.0) with initialize handshake.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProviderError } from '../types.ts';
import type { ToolContext, ToolDef, ToolOutcome } from '../types.ts';

const HANDSHAKE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ardan', version: '0.6.0' },
  },
};

export class McpServer {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (message: any | null) => void>();
  readonly serverName: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;

  constructor(
    serverName: string,
    command: string,
    args: string[],
    env: Record<string, string> = {},
  ) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = env;
  }

  async connect(): Promise<McpToolInfo[]> {
    // On Windows `npx`, `uvx` etc. are .cmd shims that spawn() cannot run
    // without a shell; quote each part so paths with spaces survive.
    const options = {
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      windowsHide: true,
    };
    const quote = (part: string) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part);
    const proc = process.platform === 'win32'
      ? spawn([this.command, ...this.args].map(quote).join(' '), { ...options, shell: true })
      : spawn(this.command, this.args, options);
    this.proc = proc;
    let spawnError: Error | undefined;
    proc.on('error', (error) => {
      spawnError = error;
      this.failAll();
    });
    proc.on('exit', () => this.failAll());
    proc.stdin.on('error', () => this.failAll());
    proc.stderr.resume(); // drain logs so the server never blocks on a full pipe
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));

    const init = await this.request(HANDSHAKE.method, HANDSHAKE.params);
    if (!init || init.error) {
      this.stop();
      const why = spawnError?.message || init?.error?.message || 'did not respond to initialize';
      throw new ProviderError(`MCP '${this.serverName}': ${why}`, 'mcp');
    }
    this.notify('notifications/initialized');
    const tools = await this.request('tools/list', {});
    return (tools?.result?.tools as McpToolInfo[]) || [];
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = undefined;
    this.failAll();
  }

  get connected(): boolean {
    return Boolean(this.proc);
  }

  /** Newline-delimited JSON-RPC: buffer partial lines across chunks. */
  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // non-JSON log line
      }
      if (typeof message?.id !== 'number') continue; // notification / server request
      const settle = this.pending.get(message.id);
      if (settle) {
        this.pending.delete(message.id);
        settle(message);
      }
    }
  }

  private failAll(): void {
    for (const settle of this.pending.values()) settle(null);
    this.pending.clear();
  }

  /**
   * Sends a request and resolves with the full JSON-RPC response envelope
   * ({ result } or { error }), or null on timeout / disconnect.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<any | null> {
    const proc = this.proc;
    if (!proc) return null;
    const id = this.nextId++;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  private notify(method: string): void {
    try {
      this.proc?.stdin?.write(
        JSON.stringify({ jsonrpc: '2.0', method, params: {} }) + '\n',
      );
    } catch {
      /* ignore */
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (!response) return { ok: false, output: `MCP '${this.serverName}' disconnected or timed out` };
    if (response.error) return { ok: false, output: response.error.message || 'MCP error' };
    const content = response.result?.content || [];
    const text = content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
    const isError = Boolean(response.result?.isError);
    return { ok: !isError && text.length > 0, output: text.slice(0, 10_000) || '(empty result)' };
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export function mcpToolDefs(
  server: McpServer,
  infos: McpToolInfo[],
): ToolDef[] {
  return infos.slice(0, 40).map((info) => {
    const qualified = `mcp__${server.serverName}__${info.name}`;
    const tool: ToolDef = {
      name: qualified,
      description: `${info.description || 'MCP tool'} (from server: ${server.serverName})`,
      permission: 'mcp',
      parameters: {
        type: 'object',
        properties: info.inputSchema?.properties || {},
        required: info.inputSchema?.required || [],
      },
      async run(args, ctx: ToolContext) {
        return await server.callTool(info.name, args);
      },
      renderCall(args) {
        return `${qualified}(${JSON.stringify(args).slice(0, 80)})`;
      },
      renderResult(outcome) {
        const flat = outcome.output.split('\n')[0].slice(0, 150);
        return { ok: outcome.ok, text: flat };
      },
    };
    return tool;
  });
}
