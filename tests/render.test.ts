// LiveRenderer streaming filter tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveRenderer } from '../src/render.ts';
import type { RenderEvent } from '../src/agent.ts';

const BK = String.fromCharCode(96);
const TRI = `${BK}${BK}${BK}`;

function bashCallJson(): string {
  return JSON.stringify({ name: 'Bash', arguments: { command: 'dir' } });
}

function collect() {
  const written: string[] = [];
  const renderer = new LiveRenderer(
    () => {},
    (text) => {
      written.push(text);
    },
  );
  renderer.setSuppressedNames(['Bash', 'Write']);
  return { renderer, written };
}

const joined = (lines: string[]) => lines.join('');

test('ordinary prose streams through untouched', () => {
  const { renderer, written } = collect();
  renderer.startTurn();
  feedText(renderer, 'Hello world.\nHow are you?');
  renderer.finishTurn();
  assert.match(joined(written), /Hello world\./);
  assert.match(joined(written), /How are you\?/);
});

test('a fenced json tool call is fully hidden', () => {
  const { renderer, written } = collect();
  renderer.startTurn();
  feedText(renderer, 'On it!\n');
  feedText(renderer, `${TRI}json\n${bashCallJson()}\n${TRI}\n`);
  renderer.event({ type: 'text', text: '' });
  feedText(renderer, 'Done.');
  renderer.finishTurn();
  const all = joined(written);
  assert.match(all, /On it!/);
  assert.match(all, /Done\./);
  assert.doesNotMatch(all, /arguments/);
  assert.doesNotMatch(all, /"name"/);
});

test('a fenced json tool call split across chunks is hidden', () => {
  const { renderer, written } = collect();
  renderer.startTurn();
  feedText(renderer, `${TRI}j`);
  feedText(renderer, `son\n${bashCallJson()}\n`);
  feedText(renderer, TRI);
  feedText(renderer, '\nfinished');
  renderer.finishTurn();
  const all = joined(written);
  assert.match(all, /finished/);
  assert.doesNotMatch(all, /arguments/);
});

test('ordinary fenced code (python etc.) is shown', () => {
  const { renderer, written } = collect();
  renderer.startTurn();
  feedText(renderer, `Example:\n${TRI}python\nprint('hi')\n${TRI}\n`);
  renderer.finishTurn();
  const all = joined(written);
  assert.match(all, /print\('hi'\)/);
});

test('a json fence that is NOT a tool call is shown verbatim', () => {
  const { renderer, written } = collect();
  renderer.startTurn();
  feedText(renderer, `${TRI}json\n{"openapi": "3.0"}\n${TRI}\n`);
  renderer.finishTurn();
  assert.match(joined(written), /openapi/);
});

test('nothing is lost when the turn ends mid-fence', () => {
  const { renderer, written } = collect();
  renderer.startTurn();
  feedText(renderer, 'answer part\n');
  feedText(renderer, `${TRI}json\n{"name": "Bash"}`);
  renderer.finishTurn();
  const all = joined(written);
  assert.match(all, /answer part/);
  assert.match(all, /"name": "Bash"/, 'unclosed block flushed verbatim');
});

function feedText(renderer: LiveRenderer, text: string): void {
  const event: RenderEvent = { type: 'text', text };
  renderer.event(event);
}
