// Session store roundtrip + replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session.ts';

process.env.ARDAN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-cfg-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-proj-'));

test('append + replay roundtrip', () => {
  const store = new SessionStore(cwd);
  store.appendEvent({ type: 'user', text: 'fix the bug' });
  store.appendEvent({
    type: 'assistant',
    text: 'on it',
    toolCalls: [{ id: 'c1', name: 'Read', args: { file_path: 'a.ts' } }],
  });
  store.appendEvent({ type: 'tool_result', toolCallId: 'c1', toolName: 'Read', ok: true, output: '...ok...' });
  store.appendEvent({ type: 'assistant', text: 'fixed' });

  const replayed = store.replay();
  assert.equal(replayed.length, 4);
  assert.equal(replayed[0].role, 'user');
  assert.equal(replayed[1].role, 'assistant');
  assert.equal(replayed[1].toolCalls?.[0]?.name, 'Read');
  assert.equal(replayed[2].role, 'tool');
  assert.equal(replayed[2].toolCallId, 'c1');
  assert.equal(replayed[3].role, 'assistant');

  const sessions = SessionStore.list(cwd);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, store.id);
  assert.match(sessions[0].preview, /fix the bug/);
});

test('compact trims old events but keeps recent', () => {
  const store = new SessionStore(cwd);
  for (let i = 0; i < 45; i++) {
    store.appendEvent({ type: 'user', text: `message ${i}` });
  }
  store.compact();
  const replayed = store.replay();
  assert.ok(replayed.length >= 39, 'kept recent events');
  assert.match(replayed[replayed.length - 1].content, /message 44/);
});
