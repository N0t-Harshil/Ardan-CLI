// Agent loop test with a scripted fake provider (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../src/agent.ts';
import type { ChatMessage, StreamEvent, ToolDef } from '../src/types.ts';

interface ScriptEvent {
  type: string;
  text?: string;
  call?: { id: string; name: string; args: Record<string, unknown> };
}

class FakeProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  readonly label = 'fake';
  scripts: ScriptEvent[][];

  constructor(scripts: ScriptEvent[][]) {
    this.scripts = scripts;
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    const script = (this.scripts.shift() || []) as unknown as StreamEvent[];
    for (const event of script) yield event;
  }
}

const addTool: ToolDef = {
  name: 'add',
  description: 'adds two numbers',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  async run(args) {
    return { ok: true, output: `sum ${Number(args.a) + Number(args.b)}` };
  },
  renderCall(args) {
    return `add(${args.a}, ${args.b})`;
  },
  renderResult(outcome) {
    return { ok: true, text: outcome.output };
  },
};

test('agent loop executes tool and reports tool result into history', async () => {
  const provider = new FakeProvider([
    [{ type: 'tool_call', call: { id: 't1', name: 'add', args: { a: 1, b: 2 } } }, { type: 'end' }],
    [{ type: 'text', text: 'The sum is 3.' }, { type: 'end' }],
  ]);
  const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  const seen: string[] = [];
  const result = await runAgentLoop({
    provider: provider as never,
    tools: [addTool],
    history,
    input: 'compute 1+2',
    workdir: '.',
    maxTurns: 4,
    permissionGate: async () => true,
    onEvent: (event) => {
      if (event.type === 'tool_result') seen.push(event.result || '');
    },
  });
  assert.equal(result.text, 'The sum is 3.');
  assert.equal(result.toolCallsUsed, 1);
  assert.ok(seen[0].includes('sum 3'));
  const toolMessage = history.find((m) => m.role === 'tool');
  assert.ok(toolMessage, 'tool result message recorded');
  assert.match(toolMessage.content, /OK\).*sum 3/);
  assert.equal(provider.scripts.length, 0, 'both turns consumed');
});

test('unknown tool produces an error result, loop continues', async () => {
  const provider = new FakeProvider([
    [{ type: 'tool_call', call: { id: 't2', name: 'nope', args: {} } }, { type: 'end' }],
    [{ type: 'text', text: 'done anyway' }, { type: 'end' }],
  ]);
  const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  const result = await runAgentLoop({
    provider: provider as never,
    tools: [addTool],
    history,
    input: 'x',
    workdir: '.',
    maxTurns: 4,
    permissionGate: async () => true,
    onEvent: () => {},
  });
  const toolMessage = history.find((m) => m.role === 'tool');
  assert.match(toolMessage?.content || '', /Unknown tool "nope"/);
  assert.equal(result.text, 'done anyway');
});

test('pre-aborted signal stops before calling the provider', async () => {
  const provider = new FakeProvider([[{ type: 'text', text: 'never' }]]);
  const controller = new AbortController();
  controller.abort();
  const result = await runAgentLoop({
    provider: provider as never,
    tools: [addTool],
    history: [],
    input: 'hi',
    workdir: '.',
    permissionGate: async () => true,
    onEvent: () => {},
    signal: controller.signal,
  });
  assert.equal(result.aborted, true);
  assert.equal(provider.scripts.length, 1, 'provider never invoked');
});
