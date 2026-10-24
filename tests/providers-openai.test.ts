// OpenAI-compatible adapter against a mock SSE server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatProvider } from '../src/providers/openai.ts';
import { streamSse } from '../src/providers/sse.ts';
import type { StreamEvent } from '../src/types.ts';

test('sse parser splits events', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: one\n\ndata: two\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });
  const events: string[] = [];
  for await (const payload of streamSse(body)) events.push(payload);
  assert.deepEqual(events, ['one', 'two']);
});

test('openai adapter streams text and complete tool calls', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '' } }] } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"dir"}' } }] } }] })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  const provider = new OpenAICompatProvider(
    { name: 'mock', model: 'm1' },
    `http://127.0.0.1:${address.port}/v1`,
    'test-key',
  );
  const events: StreamEvent[] = [];
  for await (const event of provider.stream([{ role: 'user', content: 'hi' }], [], new AbortController().signal)) {
    events.push(event);
  }
  server.close();

  const text = events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('');
  assert.equal(text, 'Hello');
  const call = events.find((event) => event.type === 'tool_call') as { call?: { name: string; args: Record<string, unknown> } };
  assert.equal(call?.call?.name, 'Bash');
  assert.deepEqual(call?.call?.args, { command: 'dir' });
  assert.ok(events.some((event) => event.type === 'end'));
});

test('http errors raise ProviderError with status', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"bad key"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const provider = new OpenAICompatProvider(
    { name: 'mock', model: 'm1' },
    `http://127.0.0.1:${address.port}/v1`,
    'wrong',
  );
  await assert.rejects(
    () => provider.stream([{ role: 'user', content: 'hi' }], [], new AbortController().signal).next(),
    /HTTP 401/,
  );
  server.close();
});
