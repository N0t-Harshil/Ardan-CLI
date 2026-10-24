// TodoWrite, WebFetch, WebSearch, and the sub-agent (Task) tool.
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDef } from '../types.ts';

/* ---------------------------------------------------------------------- todos */

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function todoPath(ctx: ToolContext): string {
  return path.join(ctx.workdir, '.ardan-output', 'todo.json');
}

export function todoTool(): ToolDef {
  return {
    name: 'TodoWrite',
    description:
      'Maintain a task checklist while working. Rewrite the full list each time; mark items in_progress/completed as you go.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['content', 'status'],
          },
          description: 'The complete todo list.',
        },
      },
      required: ['todos'],
    },
    async run(args, ctx) {
      const todos = Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [];
      if (!todos.length) return { ok: false, output: 'todos is required' };
      const clean = todos.slice(0, 50).map((item, index) => ({
        content: String(item?.content || `item ${index}`),
        status: (['pending', 'in_progress', 'completed'].includes(item?.status)
          ? item.status
          : 'pending') as TodoItem['status'],
      }));
      try {
        fs.mkdirSync(path.dirname(todoPath(ctx)), { recursive: true });
        fs.writeFileSync(todoPath(ctx), JSON.stringify(clean, null, 2));
      } catch {
        /* non-fatal */
      }
      const lines = clean.map((item) => {
        const box = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
        return `${box} ${item.content}`;
      });
      return { ok: true, output: `Todo list updated.\n${lines.join('\n')}` };
    },
    renderCall() {
      return 'TodoWrite(…)';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: 'checklist updated' };
    },
  };
}

/* ------------------------------------------------------------------ web tools */

function htmlToText(html: string, max = 9000): string {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, max);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** Prompt-side sleep (openclaude SleepTool): pause without holding a shell. */
export function sleepTool(): ToolDef {
  return {
    name: 'Sleep',
    description:
      'Pause for the given seconds (1-300) without running a shell process. ' +
      'Use while waiting for a background task, a dev server to warm up, or between polls.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Sleep duration (default 5, max 300).' } },
      required: [],
    },
    async run(args) {
      const seconds = Math.max(1, Math.min(Number(args.seconds) || 5, 300));
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return { ok: true, output: `slept ${seconds}s` };
    },
    renderCall(args) {
      return `Sleep(${String(args.seconds || 5)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };
}

export function webFetchTool(): ToolDef {
  return {
    name: 'WebFetch',
    description: 'Fetch a URL and return its content as plain text (HTML stripped).',
    permission: 'web',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to fetch.' } },
      required: ['url'],
    },
    async run(args) {
      const url = String(args.url || '');
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(20_000),
          redirect: 'follow',
        });
        if (!response.ok) return { ok: false, output: `HTTP ${response.status} for ${url}` };
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        if (contentType.includes('html')) {
          return { ok: true, output: htmlToText(text) };
        }
        return { ok: true, output: text.slice(0, 9000) };
      } catch (error) {
        return { ok: false, output: `fetch failed: ${(error as Error).message}` };
      }
    },
    renderCall(args) {
      return `WebFetch(${String(args.url || '').slice(0, 80)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: `${outcome.output.length} chars fetched` };
    },
  };
}

export function webSearchTool(): ToolDef {
  return {
    name: 'WebSearch',
    description:
      'Search the web (DuckDuckGo) and return top results with titles, URLs and snippets.',
    permission: 'web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
    },
    async run(args) {
      const query = String(args.query || '');
      if (!query) return { ok: false, output: 'query is required' };
      try {
        const response = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ q: query }).toString(),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return { ok: false, output: `HTTP ${response.status} from DuckDuckGo` };
        const html = await response.text();
        const results: string[] = [];
        const titleRe = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const linkRe = /class="result__a" href="([^"]+)"/g;
        const titles: string[] = [];
        let matchA: RegExpExecArray | null;
        while ((matchA = titleRe.exec(html)) !== null) titles.push(htmlToText(matchA[1], 120));
        const links: string[] = [];
        let matchL: RegExpExecArray | null;
        while ((matchL = linkRe.exec(html)) !== null) {
          let href = matchL[1];
          const uddg = /uddg=([^&]+)/.exec(href);
          if (uddg) href = decodeURIComponent(uddg[1]);
          links.push(href);
        }
        const snippets: string[] = [];
        let matchS: RegExpExecArray | null;
        while ((matchS = snippetRe.exec(html)) !== null) snippets.push(htmlToText(matchS[1], 200));
        for (let index = 0; index < Math.min(5, titles.length); index++) {
          results.push(`${index + 1}. ${titles[index]} — ${links[index] || ''}\n   ${snippets[index] || ''}`);
        }
        if (!results.length) return { ok: true, output: `no results for "${query}" (rate limit or blocked)` };
        return { ok: true, output: results.join('\n') };
      } catch (error) {
        return { ok: false, output: `search failed: ${(error as Error).message}` };
      }
    },
    renderCall(args) {
      return `WebSearch(${String(args.query || '').slice(0, 70)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.ok ? outcome.output.split('\n')[0].slice(0, 150) : outcome.output };
    },
  };
}

/* ---------------------------------------------------------------- sub-agent */

export function taskTool(
  runSubLoop: (options: {
    prompt: string;
    agent?: string;
    ctx: ToolContext;
  }) => Promise<string>,
  agentNames: string[],
): ToolDef {
  const agentHint = agentNames.length
    ? ` Available custom subagents: ${agentNames.join(', ')} (pass "subagent").`
    : '';
  return {
    name: 'Task',
    description:
      'Delegate a self-contained task to a sub-agent that runs its own tool loop (read-only tools by default) and returns a final report.' +
      agentHint,
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short label (3-5 words).' },
        prompt: { type: 'string', description: 'Full task for the sub-agent.' },
        subagent: {
          type: 'string',
          description: `Name of a custom subagent from .ardan/agents.${agentNames.length ? ` one of: ${agentNames.join(', ')}` : ''}`,
        },
      },
      required: ['description', 'prompt'],
    },
    async run(args, ctx) {
      const prompt = String(args.prompt || '');
      if (!prompt) return { ok: false, output: 'prompt is required' };
      try {
        const report = await runSubLoop({
          prompt,
          agent: args.subagent ? String(args.subagent) : undefined,
          ctx,
        });
        return { ok: true, output: report };
      } catch (error) {
        return { ok: false, output: `sub-agent failed: ${(error as Error).message}` };
      }
    },
    renderCall(args) {
      const agent = args.subagent ? `, ${String(args.subagent)}` : '';
      return `Task(${String(args.description || '').slice(0, 40)}${agent})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.ok ? 'sub-agent finished' : outcome.output.slice(0, 150) };
    },
  };
}

