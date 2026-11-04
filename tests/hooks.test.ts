// Hooks engine: matcher semantics + real PreToolUse shell hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookMatches, runHook, describeHookBlock, hooksFor } from '../src/plugins/hooks.ts';

const workdir = process.cwd();

test('hookMatches honors regex-ish matcher lists', () => {
  assert.equal(hookMatches({ command: 'x', matcher: 'Bash|Write' }, 'Bash'), true);
  assert.equal(hookMatches({ command: 'x', matcher: 'Bash|Write' }, 'Write'), true);
  assert.equal(hookMatches({ command: 'x', matcher: 'Bash|Write' }, 'Read'), false);
  assert.equal(hookMatches({ command: 'x' }, 'Anything'), true);
  assert.equal(hookMatches({ command: 'x', matcher: 'Bash' }, undefined), false);
});

test('runHook blocks on non-zero exit (PreToolUse guard)', async () => {
  const result = await runHook({ command: 'exit 1' }, { event: 'PreToolUse', tool: 'Bash' }, workdir);
  assert.equal(result.blocked, true);
});

test('runHook passes when exit 0 and captures stdout', async () => {
  const result = await runHook({ command: 'echo hook-ok' }, { event: 'PreToolUse', tool: 'Bash' }, workdir);
  assert.equal(result.blocked, false);
  assert.equal(result.output, 'hook-ok');
});

test('runHook parses JSON decision + systemMessage from stdout', async () => {
  const result = await runHook(
    // portable across cmd.exe and bash (plain `echo {"..."}` loses its quotes in bash)
    { command: `node -e "console.log(JSON.stringify({decision:'block',systemMessage:'no writes on fridays'}))"` },
    { event: 'PreToolUse', tool: 'Write' },
    workdir,
  );
  assert.equal(result.decision, 'block');
  assert.equal(result.blocked, true);
  assert.equal(describeHookBlock(result), 'no writes on fridays');
});

test('runHook receives payload JSON on stdin', async () => {
  const result = await runHook(
    { command: 'node -e "process.stdin.pipe(process.stdout)"' },
    { event: 'PreToolUse', tool: 'T00L_marker' },
    workdir,
  );
  assert.equal(result.blocked, false);
  assert.ok(result.output.includes('T00L'), 'stdin payload piped to hook');
});

test('runHook survives a hook that exits without reading stdin', async () => {
  // used to raise an uncaught EPIPE on Linux/macOS and crash the process
  const payload = { event: 'PreToolUse', tool: 'Write', args: { content: 'x'.repeat(1_000_000) } };
  const result = await runHook({ command: 'exit 3' }, payload as never, workdir);
  assert.equal(result.blocked, true, 'non-zero exit blocks the tool');
});

test('hooksFor pulls configured entries per event', () => {
  assert.deepEqual(hooksFor({}, 'SessionStart'), []);
  assert.equal(
    hooksFor({ hooks: { PostToolUse: [{ command: 'log.cmd' }] } }, 'PostToolUse').length,
    1,
  );
});
