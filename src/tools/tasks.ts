// TaskV2 tools: TaskCreate / TaskGet / TaskUpdate / TaskList.
// Persisted per-project at .ardan-output/tasks.json.
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../types.ts';

export interface TaskItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export function tasksFile(workdir: string): string {
  return path.join(workdir, '.ardan-output', 'tasks.json');
}

export function readTasks(workdir: string): TaskItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFile(workdir), 'utf8'));
    return Array.isArray(parsed) ? (parsed as TaskItem[]) : [];
  } catch {
    return [];
  }
}

export function writeTasks(workdir: string, tasks: TaskItem[]): void {
  fs.mkdirSync(path.dirname(tasksFile(workdir)), { recursive: true });
  fs.writeFileSync(tasksFile(workdir), JSON.stringify(tasks, null, 2));
}

function nextId(tasks: TaskItem[]): string {
  let max = 0;
  for (const task of tasks) {
    const numeric = Number(String(task.id).replace(/^t/, ''));
    if (Number.isFinite(numeric)) max = Math.max(max, numeric);
  }
  return `t${max + 1}`;
}

const STATUSES = ['pending', 'in_progress', 'completed'];

function renderTask(task: TaskItem): string {
  const box = task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[~]' : '[ ]';
  return `${box} ${task.id}  ${task.content}`;
}

export function taskTools(): ToolDef[] {
  const create: ToolDef = {
    name: 'TaskCreate',
    description: 'Create a task in the shared task list. Use for multi-step work instead of guessing.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
    async run(args, ctx) {
      const content = String(args.content || '').trim();
      if (!content) return { ok: false, output: 'content is required' };
      const now = new Date().toISOString();
      const tasks = readTasks(ctx.workdir);
      const task: TaskItem = {
        id: nextId(tasks),
        content,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task);
      writeTasks(ctx.workdir, tasks);
      return { ok: true, output: `Created ${task.id}: ${content}` };
    },
    renderCall(args) {
      return `TaskCreate(${String(args.content || '').slice(0, 60)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };

  const get: ToolDef = {
    name: 'TaskGet',
    description: 'Read one task by id.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async run(args, ctx) {
      const task = readTasks(ctx.workdir).find((t) => t.id === args.id);
      if (!task) return { ok: false, output: `no task '${args.id}'` };
      return { ok: true, output: JSON.stringify(task) };
    },
    renderCall(args) {
      return `TaskGet(${String(args.id || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.slice(0, 160) };
    },
  };

  const update: ToolDef = {
    name: 'TaskUpdate',
    description: 'Update a task status (pending/in_progress/completed) or content.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['id'],
    },
    async run(args, ctx) {
      const tasks = readTasks(ctx.workdir);
      const task = tasks.find((t) => t.id === args.id);
      if (!task) return { ok: false, output: `no task '${args.id}' (see TaskList)` };
      if (args.status) {
        if (!STATUSES.includes(String(args.status))) {
          return { ok: false, output: `status must be one of ${STATUSES.join(', ')}` };
        }
        task.status = String(args.status) as TaskItem['status'];
      }
      if (args.content) task.content = String(args.content);
      task.updatedAt = new Date().toISOString();
      writeTasks(ctx.workdir, tasks);
      return { ok: true, output: renderTask(task) };
    },
    renderCall(args) {
      return `TaskUpdate(${String(args.id || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };

  const list: ToolDef = {
    name: 'TaskList',
    description: 'Show the full task list.',
    permission: 'auto',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(_args, ctx) {
      const tasks = readTasks(ctx.workdir);
      if (!tasks.length) return { ok: true, output: 'no tasks yet' };
      return { ok: true, output: tasks.map(renderTask).join('\n') };
    },
    renderCall() {
      return 'TaskList()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n')[0].slice(0, 150) };
    },
  };

  return [create, get, update, list];
}

export function findTool(tool: ToolDef[], name: string): ToolDef | undefined {
  return tool.find((t) => t.name === name);
}
