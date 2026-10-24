// TaskV2 tools: TaskCreate / TaskList / TaskUpdate / TaskGet persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskTools, readTasks } from '../src/tools/tasks.ts';
import type { ToolContext } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-tasks-'));
const ctx = (): ToolContext => ({
  workdir: tmp,
  sessionId: 'test',
  signal: new AbortController().signal,
  state: new Map(),
});
const [create, get, update, list] = taskTools();

test('task tools create, list, update, get', async () => {
  const created = await create.run({ content: 'Fix the parser' }, ctx());
  assert.equal(created.ok, true);
  assert.match(created.output, /Created t1: Fix the parser/);

  const created2 = await create.run({ content: 'Write tests' }, ctx());
  assert.match(created2.output, /t2/);

  const listed = await list.run({}, ctx());
  assert.equal(listed.ok, true);
  assert.match(listed.output, /\[ \] t1\s+Fix the parser/);
  assert.match(listed.output, /\[ \] t2\s+Write tests/);

  const updated = await update.run({ id: 't2', status: 'in_progress' }, ctx());
  assert.equal(updated.ok, true);
  assert.match(updated.output, /^\[~\] t2/);

  const got = await get.run({ id: 't2' }, ctx());
  const parsed = JSON.parse(got.output);
  assert.equal(parsed.status, 'in_progress');
  assert.equal(parsed.content, 'Write tests');
});

test('task tools validate ids and statuses', async () => {
  const missing = await update.run({ id: 't99', status: 'completed' }, ctx());
  assert.equal(missing.ok, false);
  assert.match(missing.output, /no task 't99'/);

  const bad = await update.run({ id: 't1', status: 'banana' }, ctx());
  assert.equal(bad.ok, false);
  assert.match(bad.output, /pending, in_progress, completed/);

  const empty = await create.run({ content: '' }, ctx());
  assert.equal(empty.ok, false);
  assert.match(empty.output, /content is required/);
});

test('tasks persist to .ardan-output/tasks.json', async () => {
  const tasks = readTasks(tmp);
  assert.equal(tasks.length, 2);
  assert.match(fs.readFileSync(path.join(tmp, '.ardan-output', 'tasks.json'), 'utf8'), /Write tests/);
});
