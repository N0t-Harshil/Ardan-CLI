// Background task tools: Bash run_in_background -> TaskOutput -> TaskStop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashTool } from '../src/tools/bash.ts';
import { taskOutputTool, taskStopTool, pendingBgNotifications, bgStatus, bgOutput } from '../src/tools/background.ts';
import type { ToolContext } from '../src/types.ts';

const ctx = (): ToolContext => ({
  workdir: process.cwd(),
  sessionId: 'test',
  signal: new AbortController().signal,
  state: new Map(),
});
const SLOW_COMMAND = process.platform === 'win32'
  ? 'ping -n 8 127.0.0.1 > nul'
  : 'sleep 8';

test('Bash background mode returns an id and TaskOutput reads the result', async () => {
  const state = new Map<string, unknown>();
  const context: ToolContext = { workdir: process.cwd(), sessionId: 't', signal: new AbortController().signal, state };
  const started = await bashTool().run(
    { command: process.platform === 'win32' ? 'echo bg-hello' : 'echo bg-hello', run_in_background: true },
    context,
  );
  assert.equal(started.ok, true);
  const id = String(started.output.match(/ID: (b\d+)/)?.[1]);
  assert.ok(id, 'task id echoed back');

  const out = await taskOutputTool().run({ task_id: id, block: true, timeout: 10 }, context);
  assert.equal(out.ok, true);
  assert.match(out.output, /bg-hello|finished/);
  assert.match(out.output, new RegExp(`task ${id}`));
});

test('TaskStop kills a running background task', async () => {
  const state = new Map<string, unknown>();
  const context: ToolContext = { workdir: process.cwd(), sessionId: 't', signal: new AbortController().signal, state };
  await bashTool().run({ command: SLOW_COMMAND, run_in_background: true }, context);
  const out = await taskStopTool().run({ task_id: 'b1' }, context);
  assert.equal(out.ok, true);
  assert.match(out.output, /b1 stopped/);

  const again = await taskStopTool().run({ task_id: 'b9' }, context);
  assert.equal(again.ok, false);
  assert.match(again.output, /no background task 'b9'/);
});

test('TaskOutput rejects unknown ids with known id list', async () => {
  const out = await taskOutputTool().run({ task_id: 'zz', block: false }, ctx());
  assert.equal(out.ok, false);
  assert.match(out.output, /no background task 'zz'/);
});

test('pendingBgNotifications reports each finished task once', async () => {
  const context = ctx();
  await bashTool().run(
    { command: 'echo notify-me', run_in_background: true },
    context,
  );
  let notified = pendingBgNotifications(context);
  const deadline = Date.now() + 10_000;
  while (!notified.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    notified = pendingBgNotifications(context);
  }
  assert.ok(notified.length >= 1, 'finished task surfaced');
  assert.match(bgOutput(notified[0]), /notify-me/);
  assert.match(bgStatus(notified[0]), /finished/);
  const second = pendingBgNotifications(context);
  assert.equal(second.filter((task) => task.id === notified[0].id).length, 0, 'not reported twice');
});
