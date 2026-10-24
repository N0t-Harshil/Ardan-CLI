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
    clientInfo: { name: 'ardan', version: '0.3.0' },
  },
};

export class McpServer {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
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
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      windowsHide: true,
    });
    const init = await this.request(HANDSHAKE.method, HANDSHAKE.params);
    if (!init) throw new ProviderError(`MCP '${this.serverName}' did not respond to initialize`, 'mcp');
    this.notify('notifications/initialized');
    const tools = await this.request('tools/list', {});
    const info: McpToolInfo[] = tools?.tools || [];
    return info;
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = undefined;
  }

  get connected(): boolean {
    return Boolean(this.proc);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any | null> {
    if (!this.proc) return null;
    const id = this.nextId++;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.proc?.stdout?.off('data', onData);
        resolve(null);
      }, 15_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              clearTimeout(timer);
              this.proc?.stdout?.off('data', onData);
              resolve(parsed);
              return;
            }
          } catch {
            /* partial or non-json line */
          }
        }
      };
      this.proc.stdout?.setEncoding('utf8');
      this.proc.stdout?.on('data', onData);
      try {
        this.proc.stdin?.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        );
      } catch {
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
    void ctx;
    return tool;
  });
}
