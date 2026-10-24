// Fallback tool-JSON parsing tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSingleCall, scanToolJson } from '../src/utils/tooljson.ts';

const BK = String.fromCharCode(96);
const TRI = `${BK}${BK}${BK}`; // the fenced-block marker, built safely

test('extracts a function-call from a json fence and cleans the text', () => {
  const text = [
    'Sure, creating the file:',
    `${TRI}json`,
    JSON.stringify({ name: 'Write', arguments: { file_path: 'calc.py', content: 'print(5)' } }),
    TRI,
    '',
    'Now verifying.',
  ].join('\n');
  const scan = scanToolJson(text, ['Write', 'Bash']);
  assert.equal(scan.calls.length, 1);
  assert.equal(scan.calls[0].name, 'Write');
  assert.deepEqual(scan.calls[0].args, { file_path: 'calc.py', content: 'print(5)' });
  assert.match(scan.cleanedText, /Sure, creating the file:/);
  assert.match(scan.cleanedText, /Now verifying\./);
  assert.doesNotMatch(scan.cleanedText, /arguments/);
});

test('extracts two fenced calls in order', () => {
  const first = JSON.stringify({ name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } });
  const second = JSON.stringify({ name: 'Bash', arguments: { command: 'echo hi' } });
  const text = [
    'Working on it.',
    `${TRI}json`,
    first,
    TRI,
    `${TRI}json`,
    second,
    TRI,
  ].join('\n');
  const scan = scanToolJson(text, ['Write', 'Bash']);
  assert.equal(scan.calls.length, 2);
  assert.equal(scan.calls[0].name, 'Write');
  assert.equal(scan.calls[1].name, 'Bash');
  assert.match(scan.cleanedText, /Working on it/);
  assert.doesNotMatch(scan.cleanedText, /arguments/);
  assert.doesNotMatch(scan.cleanedText, new RegExp(TRI));
});

test('tool pseudo-tag form is parsed', () => {
  const inner = JSON.stringify({ name: 'Bash', arguments: { command: 'dir' } });
  const text = `${TRI}tool\n${inner}\n${TRI}/tool${TRI}`;
  const scan = scanToolJson(text, ['Bash']);
  assert.equal(scan.calls.length, 1);
  assert.equal(scan.calls[0].args['command'], 'dir');
});

test('bare tail object is parsed when no fence exists', () => {
  const text = 'Let me check. {"name": "Read", "arguments": {"file_path": "a.ts"}} right away.';
  const scan = scanToolJson(text, ['Read', 'Write']);
  assert.equal(scan.calls.length, 1);
  assert.equal(scan.calls[0].name, 'Read');
  assert.doesNotMatch(scan.cleanedText, /"file_path"/);
});

test('unknown tool names are ignored (text preserved)', () => {
  const text = [
    `${TRI}json`,
    JSON.stringify({ name: 'NotATool', arguments: {} }),
    TRI,
  ].join('\n');
  const scan = scanToolJson(text, ['Bash']);
  assert.equal(scan.calls.length, 0);
  assert.match(scan.cleanedText, /NotATool/);
});

test('arrays of calls are supported by parseSingleCall', () => {
  const payload = JSON.stringify([
    { name: 'Bash', arguments: { command: 'a' } },
    { name: 'Bash', arguments: { command: 'b' } },
  ]);
  const call = parseSingleCall(payload, new Set(['Bash']));
  assert.equal(call?.name, 'Bash');
  assert.deepEqual(call?.args, { command: 'a' });
});
