// Interactive flow tools: AskUserQuestion (clarifying picker) and the
// plan-mode transition tools (openclaude EnterPlanMode / ExitPlanMode).
// They operate through ToolContext.state:
//   state.get('ask') -> (question, options, multi) => Promise<string>
//   state.set('planModeRequest', boolean)   (applied between turns)
import type { ToolDef } from '../types.ts';

export type AskUserFn = (
  question: string,
  options?: string[],
  multi?: boolean,
) => Promise<string>;

export function askUserTool(): ToolDef {
  return {
    name: 'AskUserQuestion',
    description:
      'Ask the user a clarifying question, optionally with preset options. Use when requirements are ambiguous before doing something destructive or choosing between designs.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 6 preset answers the user picks from.',
        },
        multi: { type: 'boolean', description: 'Allow multiple selections (default false).' },
      },
      required: ['question'],
    },
    async run(args, ctx) {
      const question = String(args.question || '').trim();
      if (!question) return { ok: false, output: 'question is required' };
      const ask = ctx.state.get('ask') as AskUserFn | undefined;
      if (!ask) {
        return {
          ok: false,
          output: 'AskUserQuestion is only available in the interactive REPL. Make a reasonable default choice instead.',
        };
      }
      try {
        const answer = await ask(
          question,
          Array.isArray(args.options) ? args.options.map(String).slice(0, 6) : undefined,
          Boolean(args.multi),
        );
        return { ok: true, output: `The user answered: ${answer}` };
      } catch (error) {
        return { ok: false, output: `question failed: ${(error as Error).message}` };
      }
    },
    renderCall(args) {
      return `AskUser(${String(args.question || '').slice(0, 70)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.slice(0, 160) };
    },
  };
}

export function enterPlanModeTool(): ToolDef {
  return {
    name: 'EnterPlanMode',
    description:
      'Switch to plan mode (research-only) for deeper investigation. In plan mode you can read/glob/grep, ask the user questions, and must end with the ExitPlanMode tool presenting a numbered plan.',
    permission: 'auto',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(_args, ctx) {
      ctx.state.set('planModeRequest', true);
      return {
        ok: true,
        output:
          'Plan mode ON (applied after this turn). Research with read-only tools only, then present a numbered implementation plan and call ExitPlanMode.',
      };
    },
    renderCall() {
      return 'EnterPlanMode()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: 'plan mode on' };
    },
  };
}

export function exitPlanModeTool(): ToolDef {
  return {
    name: 'ExitPlanMode',
    description:
      'Leave plan mode after presenting the finished plan as your final message. The user reviews it; once mode switches you may implement with all tools.',
    permission: 'auto',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(_args, ctx) {
      ctx.state.set('planModeRequest', false);
      return {
        ok: true,
        output:
          'Plan mode OFF (applied after this turn). All tools are available again - wait for the user to approve before starting the implementation.',
      };
    },
    renderCall() {
      return 'ExitPlanMode()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: 'plan mode off' };
    },
  };
}
