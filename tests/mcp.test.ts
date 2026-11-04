// MCP stdio client tests against a real (fake) MCP server process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, mcpToolDefs } from '../src/tools/mcp.ts';
import { listMcpResourcesTool, readMcpResourceTool } from '../src/tools/inspect.ts';
import { buildToolRegistry } from '../src/tools/index.ts';
import type { ToolContext } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-mcp-'));
const serverScript = path.join(tmp, 'fake-mcp-server.mjs');

// A minimal newline-delimited JSON-RPC MCP server. The tools/list reply is
// padded past one pipe chunk (64 KiB) and written in two halves, so the
// client must reassemble lines across 'data' events.
fs.writeFileSync(
  serverScript,
  `
import readline from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
console.error('fake server booting (stderr noise is ignored)');
process.stdout.write('this is a log line, not JSON\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fake', version: '1' } } });
    case 'tools/list': {
      const text = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'echo', description: 'Echo text back. ' + 'x'.repeat(100_000), inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'fail', description: 'Always errors', inputSchema: { type: 'object', properties: {} } },
      ] } }) + '\\n';
      const half = Math.floor(text.length / 2);
      process.stdout.write(text.slice(0, half));
      setTimeout(() => process.stdout.write(text.slice(half)), 30);
      return;
    }
    case 'tools/call':
      if (msg.params.name === 'fail') return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + msg.params.arguments.text }] } });
    case 'resources/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { resources: [{ uri: 'mem://readme', name: 'readme', mimeType: 'text/plain' }] } });
    case 'resources/read':
      return send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri: msg.params.uri, text: 'hello from a resource' }] } });
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`,
  'utf8',
);

const ctx = (): ToolContext => ({
  workdir: tmp,
  sessionId: 'mcp-test',
  signal: new AbortController().signal,
  state: new Map(),
});

test('MCP client: handshake, chunked tools/list, tools/call, resources', { timeout: 20_000 }, async () => {
  const server = new McpServer('fake', process.execPath, [serverScript]);
  try {
    const infos = await server.connect();
    assert.deepEqual(infos.map((info) => info.name), ['echo', 'fail']);

    const defs = mcpToolDefs(server, infos);
    assert.equal(defs[0].name, 'mcp__fake__echo');
    assert.deepEqual(defs[0].parameters.required, ['text']);

    const echoed = await defs[0].run({ text: 'hi' }, ctx());
    assert.deepEqual(echoed, { ok: true, output: 'echo: hi' });

    const failed = await defs[1].run({}, ctx());
    assert.equal(failed.ok, false);
    assert.equal(failed.output, 'boom');

    const registry = buildToolRegistry(async () => '', { mcpServers: [server] });
    assert.ok(registry.some((tool) => tool.name === 'ListMcpResources'));

    const listed = await listMcpResourcesTool([server]).run({}, ctx());
    assert.match(listed.output, /mem:\/\/readme/);

    const read = await readMcpResourceTool([server]).run({ server: 'fake', uri: 'mem://readme' }, ctx());
    assert.equal(read.ok, true);
    assert.match(read.output, /hello from a resource/);
  } finally {
    server.stop();
  }
});

test('MCP client: a command that does not exist fails fast with a clear error', { timeout: 20_000 }, async () => {
  const server = new McpServer('ghost', 'ardan-no-such-mcp-binary-xyz', []);
  const started = Date.now();
  await assert.rejects(server.connect(), /MCP 'ghost'/);
  assert.ok(Date.now() - started < 10_000, 'did not wait for the full request timeout');
  assert.equal(server.connected, false);
});
