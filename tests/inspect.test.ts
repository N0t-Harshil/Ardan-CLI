// Inspection tools: NodeRepl persistence, NotebookEdit, CtxInspect, Skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeReplTool, notebookEditTool, ctxInspectTool, repoMapTool } from '../src/tools/inspect.ts';
import { skillTool } from '../src/tools/skillstool.ts';
import type { ChatMessage, ToolContext } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-inspect-'));
const state = new Map<string, unknown>();
const ctx = (): ToolContext => ({
  workdir: tmp,
  sessionId: 'test',
  signal: new AbortController().signal,
  state,
});

test('NodeRepl evaluates and persists state across calls', async () => {
  const repl = nodeReplTool();
  const first = await repl.run({ code: 'var x = 6 * 7; result = x' }, ctx());
  assert.equal(first.ok, true);
  assert.match(first.output, /=> 42/);

  const second = await repl.run({ code: 'result + 1' }, ctx());
  assert.match(second.output, /=> 43/);

  const withLog = await repl.run({ code: 'console.log("side"); "done"' }, ctx());
  assert.match(withLog.output, /side/);
  assert.match(withLog.output, /done/);
});

test('NodeRepl reports eval errors cleanly', async () => {
  const outcome = await nodeReplTool().run({ code: 'null.getIt()' }, ctx());
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /TypeError/);
});

test('NotebookEdit edits, inserts and deletes cells', async () => {
  const notebook = path.join(tmp, 'nb.ipynb');
  fs.writeFileSync(
    notebook,
    JSON.stringify({
      cells: [
        { cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null },
        { cell_type: 'markdown', source: ['# Title'], metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  const edit = await notebookEditTool().run(
    { notebook_path: notebook, cell: 0, new_source: 'print(42)' },
    ctx(),
  );
  assert.equal(edit.ok, true);
  const parsed = JSON.parse(fs.readFileSync(notebook, 'utf8'));
  assert.deepEqual(parsed.cells[0].source, ['print(42)']);

  const insert = await notebookEditTool().run(
    { notebook_path: notebook, insert_after: 0, new_source: 'import os\ncwd = os.getcwd()', cell_type: 'code' },
    ctx(),
  );
  assert.equal(insert.ok, true);
  const after = JSON.parse(fs.readFileSync(notebook, 'utf8'));
  assert.equal(after.cells.length, 3);
  assert.deepEqual(after.cells[1].source, ['import os\n', 'cwd = os.getcwd()']);

  const del = await notebookEditTool().run({ notebook_path: notebook, cell: 2, delete: true }, ctx());
  assert.equal(del.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(notebook, 'utf8')).cells.length, 2);
});

test('CtxInspect reports context composition from shared state', async () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'system prompt here' },
    { role: 'user', content: 'hello hello hello' },
  ];
  state.set('historyRef', history);
  state.set('toolNames', ['Read', 'Bash']);
  const outcome = await ctxInspectTool().run({}, ctx());
  assert.equal(outcome.ok, true);
  assert.match(outcome.output, /messages: 2/);
  assert.match(outcome.output, /system:1, user:1|user:1, system:1/);
  assert.match(outcome.output, /tools in catalog: 2/);
});

test('RepoMap maps the project tree with counts', async () => {
  fs.mkdirSync(path.join(tmp, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'nested', 'deep.txt'), 'abcdefgh');
  const outcome = await repoMapTool().run({ path: '.' }, ctx());
  assert.equal(outcome.ok, true);
  assert.match(outcome.output, /nested\/\s+1 files/);
  assert.match(outcome.output, /tasks\.json|nb\.ipynb/);
});

test('Skill tool loads SKILL.md content, rejects unknown names', async () => {
  const skill = skillTool([
    { name: 'demo', description: 'demo skill', file: path.join(tmp, 'SKILL.md'), dir: tmp, allowedTools: [], userInvocable: true },
  ]);
  fs.writeFileSync(path.join(tmp, 'SKILL.md'), '---\nname: demo\n---\nDemo instructions body.\n');
  const loaded = await skill.run({ name: 'demo' }, ctx());
  assert.equal(loaded.ok, true);
  assert.match(loaded.output, /Demo instructions body\./);

  const miss = await skill.run({ name: 'nope' }, ctx());
  assert.equal(miss.ok, false);
  assert.match(miss.output, /unknown skill/);
});
