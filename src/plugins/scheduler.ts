// Scheduler: cron-like scheduled prompts (openclaude CronCreate/List/Delete).
// Storage: <project>/.ardan/scheduled_tasks.json
//
// Schedule formats (our own, documented in the README):
//   every:<minutes>     recurring every N minutes (>= 1)
//   daily:<HH:MM>       recurring each day at HH:MM
//   at:<ISO date>       one-shot wall-clock time; auto-deletes after firing
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDef } from '../types.ts';

export interface ScheduledTask {
  id: string;
  prompt: string;
  kind: 'every' | 'daily' | 'at';
  minutes?: number;
  time?: string; // HH:MM
  at?: string; // ISO date
  recurring: boolean;
  createdAt: string;
  lastFired?: string;
}

export function scheduleFile(workdir: string): string {
  return path.join(workdir, '.ardan', 'scheduled_tasks.json');
}

export function readSchedule(workdir: string): ScheduledTask[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(scheduleFile(workdir), 'utf8'));
    return Array.isArray(parsed?.tasks) ? (parsed.tasks as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

export function writeSchedule(workdir: string, tasks: ScheduledTask[]): void {
  fs.mkdirSync(path.dirname(scheduleFile(workdir)), { recursive: true });
  fs.writeFileSync(scheduleFile(workdir), JSON.stringify({ tasks }, null, 2));
}

/** "every:30m" | "daily:HH:MM" | "at:ISO" -> task fields, or an error. */
export function parseSchedule(input: string): { error?: string; task?: Partial<ScheduledTask> } {
  const raw = input.trim();
  if (/^every:\d+m$/i.test(raw)) {
    const minutes = Number(raw.match(/(\d+)/)?.[1] ?? 0);
    if (minutes < 1) return { error: 'minutes must be >= 1' };
    return { task: { kind: 'every', minutes, recurring: true } as Partial<ScheduledTask> };
  }
  if (/^daily:\d{1,2}:\d{2}$/i.test(raw)) {
    const [, hh, mm] = raw.split(/[:]/); // daily:HH:MM -> [daily, HH, MM]
    return { task: { kind: 'daily', time: `${String(Number(hh)).padStart(2, '0')}:${mm}`, recurring: true } as Partial<ScheduledTask> };
  }
  if (/^at:/i.test(raw)) {
    const when = new Date(raw.slice(3));
    if (Number.isNaN(when.getTime())) return { error: 'at: expects an ISO date like 2026-10-25T09:30' };
    return { task: { kind: 'at', at: when.toISOString(), recurring: false } as Partial<ScheduledTask> };
  }
  return { error: 'schedule must be every:<minutes>m, daily:<HH:MM> or at:<ISO date>' };
}

/** Tasks due right now; marks lastFired / removes one-shots once delivered. */
export function checkDue(workdir: string, now = new Date()): ScheduledTask[] {
  const tasks = readSchedule(workdir);
  const due: ScheduledTask[] = [];
  const keep: ScheduledTask[] = [];
  for (const task of tasks) {
    let isDue = false;
    if (task.kind === 'every') {
      const last = task.lastFired ? new Date(task.lastFired).getTime() : new Date(task.createdAt).getTime();
      isDue = now.getTime() - last >= (task.minutes || 0) * 60_000;
    } else if (task.kind === 'daily') {
      const today = now.toISOString().slice(0, 10);
      const firedDay = task.lastFired?.slice(0, 10);
      const [hh, mm] = (task.time || '00:00').split(':').map(Number);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      isDue = firedDay !== today && nowMinutes >= hh * 60 + mm && nowMinutes < hh * 60 + mm + 5;
    } else if (task.kind === 'at') {
      isDue = task.at !== undefined && new Date(task.at).getTime() <= now.getTime();
    }
    if (isDue) {
      due.push(task);
      if (task.recurring) {
        keep.push({ ...task, lastFired: now.toISOString() });
      }
      // one-shots are dropped once fired
    } else {
      keep.push(task);
    }
  }
  if (due.length) writeSchedule(workdir, keep);
  return due;
}

export const MAX_SCHEDULED_TASKS = 50;

export function cronTools(): ToolDef[] {
  const create: ToolDef = {
    name: 'CronCreate',
    description:
      'Schedule a prompt to fire automatically while this session runs: every:<minutes>m, daily:<HH:MM> or at:<ISO date>. Max 50 jobs; one-shots fire once.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt/reminder to run when the schedule fires.' },
        schedule: { type: 'string', description: 'every:<minutes>m | daily:<HH:MM> | at:<ISO date>' },
      },
      required: ['prompt', 'schedule'],
    },
    async run(args, ctx) {
      const prompt = String(args.prompt || '').trim().slice(0, 10_000);
      if (!prompt) return { ok: false, output: 'prompt is required' };
      const parsed = parseSchedule(String(args.schedule || ''));
      if (parsed.error || !parsed.task) return { ok: false, output: parsed.error || 'invalid schedule' };
      const tasks = readSchedule(ctx.workdir);
      if (tasks.length >= MAX_SCHEDULED_TASKS) {
        return { ok: false, output: `schedule full (${MAX_SCHEDULED_TASKS} jobs) - delete one first` };
      }
      const task: ScheduledTask = {
        ...parsed.task,
        id: `sc${Date.now().toString(36)}`,
        prompt,
        createdAt: new Date().toISOString(),
      } as ScheduledTask;
      tasks.push(task);
      writeSchedule(ctx.workdir, tasks);
      return { ok: true, output: `scheduled ${task.id} (${String(args.schedule)}) -> "${prompt.slice(0, 80)}"` };
    },
    renderCall(args) {
      return `CronCreate(${String(args.schedule || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.slice(0, 150) };
    },
  };

  const list: ToolDef = {
    name: 'CronList',
    description: 'Show scheduled prompts (id, schedule, prompt).',
    permission: 'auto',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(_args, ctx) {
      const tasks = readSchedule(ctx.workdir);
      if (!tasks.length) return { ok: true, output: 'no scheduled tasks' };
      return {
        ok: true,
        output: tasks
          .map((task) =>
            `- ${task.id} ${task.kind === 'every' ? `every ${task.minutes}m` : task.kind === 'daily' ? `daily ${task.time}` : `at ${task.at}`}${task.recurring ? '' : ' (once)'}: ${task.prompt.slice(0, 70)}`,
          )
          .join('\n'),
      };
    },
    renderCall() {
      return 'CronList()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n').length > 1 ? `${outcome.output.split('\n').length} jobs` : 'no scheduled tasks' };
    },
  };

  const del: ToolDef = {
    name: 'CronDelete',
    description: 'Delete a scheduled prompt by id (see CronList).',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async run(args, ctx) {
      const tasks = readSchedule(ctx.workdir);
      const remaining = tasks.filter((task) => task.id !== args.id);
      if (remaining.length === tasks.length) {
        return { ok: false, output: `no scheduled task '${args.id}'` };
      }
      writeSchedule(ctx.workdir, remaining);
      return { ok: true, output: `deleted ${args.id}` };
    },
    renderCall(args) {
      return `CronDelete(${String(args.id || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output };
    },
  };

  return [create, list, del];
}
