// End-to-end: launch the real `ardan` CLI against a scripted
// OpenAI-compatible server. The "model" asks for real tool calls (Write a
// file, then run it with Bash), and the test checks the file on disk, the
// command's output fed back to the model, and the final answer printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const root = path.resolve(import.meta.dirname, '..');

function sse(res: http.ServerResponse, deltas: object[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const delta of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const toolCall = (id: string, name: string, args: object) => ({
  tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('CLI one-shot run: model writes a file, runs it, reports the result', { timeout: 60_000 }, async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-e2e-work-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-e2e-config-'));
  const requests: any[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body);
      requests.push(request);
      const toolResults = request.messages.filter((m: any) => m.role === 'tool');
      if (toolResults.length === 0) {
        return sse(res, [
          { content: 'I will create the script. ' },
          toolCall('call_1', 'Write', {
            file_path: 'sum.js',
            content: 'console.log("sum=" + [1, 2, 3, 4].reduce((a, b) => a + b, 0));\n',
          }),
        ]);
      }
      if (toolResults.length === 1) {
        return sse(res, [toolCall('call_2', 'Bash', { command: 'node sum.js' })]);
      }
      const last = String(toolResults.at(-1).content);
      const answer = last.includes('sum=10') ? 'Done: the script printed sum=10.' : `Unexpected: ${last}`;
      return sse(res, [{ content: answer }]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const child = spawn(
      process.execPath,
      [path.join(root, 'bin', 'ardan.js'), '--yes', '--provider', 'openai', '--model', 'fake-model',
        '--cwd', workdir, 'Write sum.js that sums 1..4, run it, tell me the output'],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          ARDAN_CONFIG_DIR: configDir,
          ARDAN_DISABLE_CRON: '1',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    if (process.env.ARDAN_E2E_PRINT) console.log(output);

    assert.equal(code, 0, output);
    assert.equal(requests.length, 3, 'three model turns: Write, Bash, final answer');
    assert.equal(requests[0].model, 'fake-model');
    assert.ok(requests[0].tools.some((tool: any) => tool.function.name === 'Write'), 'tool catalog sent');
    assert.equal(
      fs.readFileSync(path.join(workdir, 'sum.js'), 'utf8'),
      'console.log("sum=" + [1, 2, 3, 4].reduce((a, b) => a + b, 0));\n',
    );
    assert.match(output, /Done: the script printed sum=10\./);
  } finally {
    server.close();
  }
});

// Regression: on Windows, process.exit() right after a tool-using run
// aborted Node with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
// (exit code 0xC0000409) almost every time. Exit must be clean and fast.
test('CLI exits cleanly (code 0) after a tool-using run, every time', { timeout: 60_000 }, async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-exit-work-'));
  fs.writeFileSync(path.join(workdir, 'notes.txt'), 'hello\n');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const answered = JSON.parse(body).messages.some((m: any) => m.role === 'tool');
      sse(res, [answered ? { content: 'done' } : toolCall('c1', 'Read', { file_path: 'notes.txt' })]);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    for (let run = 0; run < 5; run++) {
      const started = Date.now();
      const child = spawn(
        process.execPath,
        [path.join(root, 'bin', 'ardan.js'), '--yes', '--provider', 'openai', '--model', 'm', '--cwd', workdir, 'read notes.txt'],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            ARDAN_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-exit-config-')),
            ARDAN_DISABLE_CRON: '1',
            NO_COLOR: '1',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      assert.equal(code, 0, `run ${run}: ${stderr}`);
      assert.doesNotMatch(stderr, /Assertion failed/);
      assert.ok(Date.now() - started < 1_900, 'exited without waiting for the forced-exit fallback');
    }
  } finally {
    server.close();
  }
});
