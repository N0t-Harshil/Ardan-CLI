// Ollama native adapter against a local fake /api/chat server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaProvider } from '../src/providers/ollama.ts';
import type { StreamEvent } from '../src/types.ts';

async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collect(provider: OllamaProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(
    [{ role: 'user', content: 'hi' }],
    [],
    new AbortController().signal,
  )) events.push(event);
  return events;
}

test('ollama adapter streams text, unique tool-call ids and real generation tok/s', async () => {
  let received: any;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const lines = [
        { message: { content: 'Hel' } },
        { message: { content: 'lo' } },
        { message: { tool_calls: [
          { function: { name: 'Read', arguments: { file_path: 'a.ts' } } },
          { function: { name: 'Read', arguments: { file_path: 'b.ts' } } },
        ] } },
        // 40 tokens in 2s of generation -> 20 tok/s (prefill excluded)
        { done: true, eval_count: 40, eval_duration: 2_000_000_000, prompt_eval_count: 900 },
      ];
      // split one JSON line across two writes to exercise buffering
      const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
      res.write(text.slice(0, 25));
      setTimeout(() => res.end(text.slice(25)), 10);
    });
  }, async (baseUrl) => {
    const provider = new OllamaProvider({ name: 'ollama', model: 'qwen2.5-coder:14b' } as any, baseUrl);
    const events = await collect(provider);
    const text = events.filter((e) => e.type === 'text').map((e: any) => e.text).join('');
    assert.equal(text, 'Hello');
    const calls = events.filter((e) => e.type === 'tool_call').map((e: any) => e.call);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id, 'tool-call ids must be unique');
    assert.deepEqual(calls[1].args, { file_path: 'b.ts' });
    const end = events.at(-1) as any;
    assert.equal(end.type, 'end');
    assert.equal(end.tokensPerSecond, 20);
    assert.equal(received.model, 'qwen2.5-coder:14b');
    assert.equal(received.stream, true);
    assert.equal(received.options.num_predict, 8192, 'maxTokens is sent as num_predict');
  });
});

test('ollama adapter waits for a slow first byte (no fetch headers timeout)', { timeout: 15_000 }, async () => {
  await withServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end(JSON.stringify({ message: { content: 'late but fine' }, done: true }) + '\n');
    }, 1_500);
  }, async (baseUrl) => {
    const provider = new OllamaProvider({ name: 'ollama', model: 'm' } as any, baseUrl);
    const events = await collect(provider);
    assert.equal((events[0] as any).text, 'late but fine');
  });
});

test('ollama adapter: 404 means model not pulled; refused means not running', async () => {
  await withServer((_req, res) => {
    res.writeHead(404);
    res.end('{"error":"model not found"}');
  }, async (baseUrl) => {
    const provider = new OllamaProvider({ name: 'ollama', model: 'nope:1b' } as any, baseUrl);
    await assert.rejects(collect(provider), /not pulled\. Run: ollama pull nope:1b/);
  });
  // port 9 (discard) on loopback is closed on any normal machine
  const offline = new OllamaProvider({ name: 'ollama', model: 'm' } as any, 'http://127.0.0.1:9');
  await assert.rejects(collect(offline), /Ollama unreachable .*ollama serve/);
});
