// Tools tests: file ops, glob/grep, bash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editTool, listDirTool, readTool, writeTool } from '../src/tools/files.ts';
import { globToRegExp, globTool, grepTool } from '../src/tools/globgrep.ts';
import { bashTool } from '../src/tools/bash.ts';
import type { ToolContext } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-tools-'));
const ctx = (): ToolContext => ({
  workdir: tmp,
  sessionId: 'test',
  signal: new AbortController().signal,
  state: new Map(),
});

test('write then read roundtrip', async () => {
  const outcome = await writeTool().run({ file_path: 'a.txt', content: 'hello world' }, ctx());
  assert.equal(outcome.ok, true);
  const read = await readTool().run({ file_path: 'a.txt' }, ctx());
  assert.equal(read.ok, true);
  assert.match(read.output, /→hello world/);
  assert.match(read.output, /a\.txt/);
});

test('edit replaces unique match and reports non-unique', async () => {
  const edit = editTool().run({ file_path: 'a.txt', old_string: 'world', new_string: 'there' }, ctx());
  assert.equal((await edit).ok, true);
  const after = await readTool().run({ file_path: 'a.txt' }, ctx());
  assert.match(after.output, /hello there/);

  fs.writeFileSync(path.join(tmp, 'dup.txt'), 'x\nx\n');
  const dup = await editTool().run({ file_path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx());
  assert.equal(dup.ok, false);
  assert.match(dup.output, /2 times/);
  const all = await editTool().run({ file_path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx());
  assert.equal(all.ok, true);
});

test('glob matcher semantics', () => {
  assert.match('src/a/b.ts', globToRegExp('src/**/*.ts'));
  assert.match('src/x.ts', globToRegExp('src/**/*.ts'));
  assert.doesNotMatch('src/x.py', globToRegExp('src/**/*.ts'));
  assert.match('README.md', globToRegExp('*.md'));
  assert.doesNotMatch('src/README.md', globToRegExp('*.md'));
});

test('glob + grep find files', async () => {
  fs.mkdirSync(path.join(tmp, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'deep', 'code.ts'), 'export const answer = 42;\n');
  const g = await globTool().run({ pattern: 'deep/*.ts' }, ctx());
  assert.equal(g.ok, true);
  assert.match(g.output, /deep\/code\.ts/);

  const grep = await grepTool().run({ pattern: 'answer = 42' }, ctx());
  assert.equal(grep.ok, true);
  assert.match(grep.output, /deep\/code\.ts:1:/);
});

test('listdir shows entries', async () => {
  const listing = await listDirTool().run({}, ctx());
  assert.equal(listing.ok, true);
  assert.match(listing.output, /a\.txt/);
});

test('bash runs a command', async () => {
  const command = process.platform === 'win32' ? 'echo bang' : 'echo bang';
  const outcome = await bashTool().run({ command }, ctx());
  assert.equal(outcome.ok, true);
  assert.match(outcome.output, /bang/);
});
