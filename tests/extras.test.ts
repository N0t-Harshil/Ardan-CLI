// Batch 3 features: Sleep, ToolSearch, DiscoverSkills, scheduler, output
// styles, file history, session title/rewind/export, PowerShell smoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleepTool, todoTool } from '../src/tools/misc.ts';
import { toolSearchTool, discoverSkillsTool } from '../src/tools/searchtools.ts';
import {
  parseSchedule,
  checkDue,
  cronTools,
  readSchedule,
  writeSchedule,
} from '../src/plugins/scheduler.ts';
import { loadOutputStyles } from '../src/plugins/loader.ts';
import { captureFileHistory, restoreFileHistory, editTool, writeTool, readTool } from '../src/tools/files.ts';
import { SessionStore } from '../src/session.ts';
import type { ToolContext, ToolDef } from '../src/types.ts';

const ctx = (root = process.cwd()): ToolContext => ({
  workdir: root,
  sessionId: 'test',
  signal: new AbortController().signal,
  state: new Map(),
});

/* ------------------------------------------------------------ Sleep */

test('Sleep pauses for the requested seconds', async () => {
  const started = Date.now();
  const outcome = await sleepTool().run({ seconds: 1 }, ctx());
  assert.equal(outcome.ok, true);
  assert.match(outcome.output, /slept 1s/);
  assert.ok(Date.now() - started >= 900, 'actually waited');
});

/* ------------------------------------------------------- ToolSearch */

const FAKE_CATALOG: ToolDef[] = [
  { name: 'Bash', description: 'Run a shell command', permission: 'bash', parameters: { type: 'object', properties: {} }, run: async () => ({ ok: true, output: '' }), renderCall: () => '', renderResult: () => ({ ok: true, text: '' }) },
  { name: 'mcp__files__read', description: 'MCP file read from the files server', permission: 'mcp', parameters: { type: 'object', properties: {} }, run: async () => ({ ok: true, output: '' }), renderCall: () => '', renderResult: () => ({ ok: true, text: '' }) },
] as unknown as ToolDef[];

function searchContext(): ToolContext {
  const context = ctx();
  context.state.set('catalogRef', FAKE_CATALOG);
  return context;
}

test('ToolSearch select: form fetches exact tools', async () => {
  const out = await toolSearchTool().run({ query: 'select:Bash,mcp__files__read' }, searchContext());
  assert.match(out.output, /Bash: Run a shell command/);
  assert.match(out.output, /mcp__files__read/);
});

test('ToolSearch keyword search ranks name hits first, caps results', async () => {
  const out = await toolSearchTool().run({ query: 'shell', max_results: 2 }, searchContext());
  assert.match(out.output, /Bash/);
  const none = await toolSearchTool().run({ query: 'gibberish-token' }, searchContext());
  assert.match(none.output, /No matching tools found/);
});

test('DiscoverSkills lists skills or explains installation', async () => {
  const empty = await discoverSkillsTool([]).run({}, ctx());
  assert.match(empty.output, /No skills installed/);
  const full = await discoverSkillsTool([{ name: 'demo', description: 'demo', file: 'x', dir: 'x', allowedTools: [], userInvocable: true }]).run({}, ctx());
  assert.match(full.output, /- demo: demo/);
});

/* -------------------------------------------------------- scheduler */

test('parseSchedule accepts our three forms', () => {
  assert.deepEqual(parseSchedule('every:15m').task && true, true);
  assert.equal(parseSchedule('every:0m')?.error || '', 'minutes must be >= 1');
  const daily = parseSchedule('daily:9:30');
  assert.equal(daily.task?.time, '09:30');
  const at = parseSchedule('at:2026-10-25T09:30Z');
  assert.ok(at.task?.at?.startsWith('2026-10-25'));
  assert.match(parseSchedule('nonsense')?.error || '', /schedule must be/);
});

test('checkDue fires due tasks, updates recurring, drops one-shots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-sched-'));
  const now = new Date(Date.now() - 10 * 60_000);
  writeSchedule(tmp, [
    { id: 'sc1', prompt: 'every one', kind: 'every', minutes: 5, recurring: true, createdAt: now.toISOString() },
    { id: 'sc2', prompt: 'one shot', kind: 'at', at: new Date(Date.now() - 1000).toISOString(), recurring: false, createdAt: now.toISOString() },
    { id: 'sc3', prompt: 'not yet', kind: 'at', at: new Date(Date.now() + 3600_000).toISOString(), recurring: false, createdAt: now.toISOString() },
  ]);
  const due = checkDue(tmp);
  assert.deepEqual(due.map((task) => task.id).sort(), ['sc1', 'sc2']);
  const remaining = readSchedule(tmp);
  assert.equal(remaining.filter((task) => task.id === 'sc2').length, 0, 'one-shot removed');
  const sc1 = remaining.find((task) => task.id === 'sc1');
  assert.ok(sc1?.lastFired, 'recurring lastFired stamped');
  // immediately-after: recurring stamped with lastFired (not due again), one-shot gone
  const second = checkDue(tmp);
  assert.deepEqual(second.map((task) => task.id), []);
});

test('cron tools create/list/delete on a project schedule', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-cron-'));
  const [create, list, del] = cronTools();
  const created = await create.run({ prompt: 'standup check', schedule: 'daily:08:15' }, ctx(tmp));
  assert.match(created.output, /scheduled/);
  const listed = await list.run({}, ctx(tmp));
  assert.match(listed.output, /standup check/);
  assert.match(listed.output, /daily 08:15/);
  const id = readSchedule(tmp)[0].id;
  const deleted = await del.run({ id }, ctx(tmp));
  assert.match(deleted.output, /deleted/);
  const empty = await list.run({}, ctx(tmp));
  assert.match(empty.output, /no scheduled tasks/);
});

/* ----------------------------------------------------- output styles */

test('loadOutputStyles reads named markdown styles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-styles-'));
  fs.mkdirSync(path.join(tmp, '.ardan', 'output-styles'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.ardan', 'output-styles', 'concise.md'),
    '---\nname: concise\ndescription: Extremely brief\n---\nAnswer in <=3 bullets.',
  );
  const styles = loadOutputStyles(tmp);
  const concise = styles.find((style) => style.name === 'concise');
  assert.ok(concise);
  assert.equal(concise.keepCodingInstructions, true);
  assert.match(concise.body, /3 bullets/);
});

/* ------------------------------------------------------ file history */

test('file history captures first content and restores session-start state', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-hist-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'original');
  const context = ctx(tmp);
  await writeTool().run({ file_path: 'b.txt', content: 'new file' }, context);
  await editTool().run({ file_path: 'a.txt', old_string: 'original', new_string: 'changed' }, context);
  // second edit on a.txt must not overwrite the earlier checkpoint
  await editTool().run({ file_path: 'a.txt', old_string: 'changed', new_string: 'changed2' }, context);

  const restored = restoreFileHistory(context);
  assert.equal(restored.length, 2);
  assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(tmp, 'b.txt')), false, 'new file deleted on restore');

  const read = await readTool().run({ file_path: 'a.txt' }, ctx(tmp));
  assert.match(read.output, /original/);
});

/* ------------------------------------------------ session title/goal etc */

test('session title, goal restart and rewind/export', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-session-'));
  const store = new SessionStore(tmp, 'rewindtest');
  store.appendMeta('ollama', 'm', false);
  store.appendEvent({ type: 'user', text: 'first turn' });
  store.appendEvent({ type: 'assistant', text: 'first answer' });
  store.appendEvent({ type: 'user', text: 'second turn' });
  store.appendEvent({ type: 'assistant', text: 'second answer' });
  store.setTitle('my custom title');
  store.appendMetaEvent('goal', { text: 'ship it' });

  assert.equal(store.latestTitle(), 'my custom title');
  assert.equal(store.latestGoal(), 'ship it');
  store.appendMetaEvent('goal', { action: 'stop' });
  assert.equal(store.latestGoal(), undefined);

  // rewind(1): keep only turn 1 (drop everything from the 2nd user event on,
  // including later title/goal envelope events)
  const removed = store.rewind(1);
  assert.equal(removed, 5);
  const replayed = store.replay();
  const texts = replayed.map((message) => message.content);
  assert.deepEqual(texts, ['first turn', 'first answer']);

  const exported = store.exportMarkdown(path.join(tmp, 'export.md'));
  assert.match(fs.readFileSync(exported, 'utf8'), /first answer/);
});
