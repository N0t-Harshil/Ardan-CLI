// Batch 6 features: auto-background migration, Monitor streaming,
// per-turn file checkpoints, Diagnostics (LSP) tool scaffolding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashTool } from '../src/tools/bash.ts';
import { monitorTool, monitorNewData } from '../src/tools/background.ts';
import { taskStopTool } from '../src/tools/background.ts';
import { captureFileHistory, restoreFileHistoryAt } from '../src/tools/files.ts';
import { diagnosticsTool, pickServer } from '../src/tools/lsp.ts';
import type { ToolContext } from '../src/types.ts';

const ctx = (root = process.cwd()): ToolContext => ({
  workdir: root,
  sessionId: 'test',
  signal: new AbortController().signal,
  state: new Map(),
});

const SLOW = process.platform === 'win32'
  ? 'ping -n 30 127.0.0.1 > nul'
  : 'sleep 30';

/* ------------------------------------------------- auto-backgrounding */

test('Bash foreground: a still-running command migrates to the background after ~15s', async () => {
  const context = ctx();
  const started = Date.now();
  const outcome = await bashTool().run({ command: SLOW }, context);
  assert.equal(outcome.ok, true);
  assert.match(outcome.output, /moved to background with ID (b\d+)/);
  assert.ok(Date.now() - started >= 14_000, 'waited the auto-background budget');

  const id = String(outcome.output.match(/ID (b\d+)/)?.[1]);
  const stopped = await taskStopTool().run({ task_id: id }, context);
  assert.equal(stopped.ok, true);
  assert.match(stopped.output, new RegExp(`${id} stopped`));
}, 60_000);

/* --------------------------------------------------------- Monitor */

test('Monitor registers a streaming task and monitorNewData reports fresh stdout', async () => {
  const context = ctx();
  const started = await monitorTool().run(
    {
      command: process.platform === 'win32'
        ? 'echo line1&& ping -n 2 127.0.0.1 > nul&& echo line2'
        : 'echo line1; sleep 2; echo line2',
    },
    context,
  );
  assert.equal(started.ok, true);
  assert.match(started.output, /reported automatically/);
  const id = String(started.output.match(/task (b\d+)/)?.[1]);
  assert.ok(id, 'monitor returns a task id');

  let delta = '';
  for (let i = 0; i < 40 && !delta; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fresh = monitorNewData(context);
    if (fresh.length) delta = fresh[0].delta;
  }
  assert.match(delta ?? '', /line1/);

  // consumed deltas are not re-reported
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(monitorNewData(context).length, 0, 'no double report of the same delta');

  await taskStopTool().run({ task_id: id }, context);
  assert.equal(monitorNewData(context).length, 0, 'stopped monitor does not stream');
}, 20_000);

/* -------------------------------------- per-turn file checkpoints */

test('/rewind files: checkpoints per turn restore as-of-turn state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-rewind-'));
  const file = path.join(root, 'notes.txt');
  fs.writeFileSync(file, 'v0');
  const state = new Map<string, unknown>();
  const context = { ...ctx(root), state };

  // turn 1 edits v0 -> v1; turn 2: v1 -> v2; turn 3: v2 -> v3
  context.state.set('turnIndex', 1);
  captureFileHistory(context, file);
  fs.writeFileSync(file, 'v1');
  context.state.set('turnIndex', 2);
  captureFileHistory(context, file);
  fs.writeFileSync(file, 'v2');
  context.state.set('turnIndex', 3);
  captureFileHistory(context, file);
  fs.writeFileSync(file, 'v3');

  const restored = restoreFileHistoryAt(context, 1);
  assert.deepEqual(restored, ['notes.txt']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1', 'state as of the end of turn 1');

  // rewinding to a turn beyond nothing: no tracked changes -> no restore
  const untouched = restoreFileHistoryAt(context, 3);
  assert.deepEqual(untouched, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1', 'pin unchanged files');
});

test('checkpoints delete files created in the rolled-back turns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-rewind2-'));
  const file = path.join(root, 'later.txt');
  fs.rmSync(file, { force: true });
  const state = new Map<string, unknown>();
  const context = { ...ctx(root), state };

  context.state.set('turnIndex', 2); // created mid-session in turn 2
  captureFileHistory(context, file); // did not exist -> content null
  fs.writeFileSync(file, 'born in turn 2');

  const restored = restoreFileHistoryAt(context, 1);
  assert.deepEqual(restored, ['later.txt']);
  assert.equal(fs.existsSync(file), false, 'rolled back to nonexistence');
});

/* --------------------------------------------------- Diagnostics/LSP */

test('Diagnostics without configured servers explains the wiring', async () => {
  const out = await diagnosticsTool([]).run({ file_path: 'src/x.ts' }, ctx());
  assert.equal(out.ok, false);
  assert.match(out.output, /lspServers/);
});

test('Diagnostics rejects missing files before spawning any server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-lsp-'));
  const server = [{ name: 'tsl', config: { command: process.execPath, extensions: ['.ts'] } }];
  const out = await diagnosticsTool(server).run({ file_path: 'nope.ts' }, ctx(root));
  assert.equal(out.ok, false);
  assert.match(out.output, /file not found/);
});

test('pickServer matches extensions and falls back to the first entry', () => {
  const servers = [
    { name: 'tsl', config: { command: 'tsl', extensions: ['.ts', '.tsx'] } },
    { name: 'pyl', config: { command: 'pylsp', extensions: ['.py'] } },
  ];
  assert.equal(pickServer(servers, 'src/a.ts')?.name, 'tsl');
  assert.equal(pickServer(servers, 'mod/b.py')?.name, 'pyl');
  assert.equal(pickServer(servers, 'doc.md')?.name, 'tsl', 'falls back to first');
  assert.equal(pickServer(servers.slice(1), 'doc.md')?.name, 'pyl', 'fallback uses first available');
  assert.equal(pickServer([], 'doc.md'), null);
});
