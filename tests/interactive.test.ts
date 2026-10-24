// Interactive tools: AskUserQuestion with a fake asker, plan-mode toggles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askUserTool, enterPlanModeTool, exitPlanModeTool } from '../src/tools/interactive.ts';
import type { ToolContext } from '../src/types.ts';
import type { AskUserFn } from '../src/tools/interactive.ts';

const ctxWith = (extra: Record<string, unknown>): ToolContext => ({
  workdir: process.cwd(),
  sessionId: 'test',
  signal: new AbortController().signal,
  state: new Map(Object.entries(extra)),
});

test('AskUserQuestion returns the picked answer through the asker', async () => {
  const asker: AskUserFn = async (_question, options) => options?.[1] || 'typed';
  const outcome = await askUserTool().run(
    { question: 'Which DB?', options: ['postgres', 'sqlite'] },
    ctxWith({ ask: asker }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.output, 'The user answered: sqlite');
});

test('AskUserQuestion merges multi-line picks', async () => {
  const asker: AskUserFn = async (_q, _o, multi) => (multi ? 'yes | maybe' : 'no');
  const outcome = await askUserTool().run(
    { question: 'pick', options: ['yes', 'no', 'maybe'], multi: true },
    ctxWith({ ask: asker }),
  );
  assert.equal(outcome.output, 'The user answered: yes | maybe');
});

test('AskUserQuestion without an asker reports guidance', async () => {
  const outcome = await askUserTool().run({ question: 'why?' }, ctxWith({}));
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /not reasonably answerable|interactive|Make a reasonable/);
});

test('EnterPlanMode / ExitPlanMode set the request state', async () => {
  const state = new Map<string, unknown>();
  const ctx: ToolContext = {
    workdir: process.cwd(),
    sessionId: 't',
    signal: new AbortController().signal,
    state,
  };
  const enter = await enterPlanModeTool().run({}, ctx);
  assert.equal(enter.ok, true);
  assert.equal(state.get('planModeRequest'), true);
  assert.match(enter.output, /Plan mode ON/);

  const exit = await exitPlanModeTool().run({}, ctx);
  assert.equal(exit.ok, true);
  assert.equal(state.get('planModeRequest'), false);
  assert.match(exit.output, /Plan mode OFF/);
});
