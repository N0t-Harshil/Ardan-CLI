// Sessions: JSONL transcripts under ~/.ardan/projects/<workdir-slug>/
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage, SessionEvent, ToolCall } from './types.ts';

export function configDir(): string {
  return process.env.ARDAN_CONFIG_DIR || path.join(os.homedir(), '.ardan');
}

export function slugFor(cwd: string): string {
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12);
  return `${path.basename(cwd).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}-${hash}`;
}

export function projectDir(cwd: string): string {
  return path.join(configDir(), 'projects', slugFor(cwd));
}

export interface SessionMeta {
  id: string;
  file: string;
  created: string;
  updated: string;
  events: number;
  preview: string;
}

export class SessionStore {
  readonly id: string;
  readonly file: string;
  readonly cwd: string;

  constructor(cwd: string, sessionId?: string) {
    const dir = projectDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    this.id = sessionId || `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    this.file = path.join(dir, `${this.id}.jsonl`);
    this.cwd = cwd;
  }

  append(event: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      /* ignore write failures */
    }
  }

  appendMeta(provider: string, model: string, planMode: boolean): void {
    this.append({
      type: 'meta',
      id: this.id,
      at: new Date().toISOString(),
      cwd: this.cwd,
      provider,
      model,
      planMode,
    });
  }

  appendEvent(event: SessionEvent): void {
    this.append({ type: event.type, ...event });
  }

  /** Store auxiliary envelope events (title, goal) that replay ignores. */
  appendMetaEvent(type: string, fields: Record<string, unknown>): void {
    this.append({ type, at: new Date().toISOString(), ...fields });
  }

  eventsOfType(type: string): Array<Record<string, unknown>> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .filter((entry) => entry.type === type);
    } catch {
      return [];
    }
  }

  setTitle(title: string): void {
    this.appendMetaEvent('custom-title', { customTitle: title.slice(0, 80) });
  }

  latestTitle(): string | undefined {
    const titles = this.eventsOfType('custom-title');
    if (!titles.length) return undefined;
    const last = titles[titles.length - 1];
    return typeof last.customTitle === 'string' ? last.customTitle : undefined;
  }

  latestGoal(): string | undefined {
    const goals = this.eventsOfType('goal');
    if (!goals.length) return undefined;
    const last = goals[goals.length - 1];
    if (last.action === 'stop') return undefined;
    return typeof last.text === 'string' ? last.text : undefined;
  }

  /**
   * Truncate the transcript so everything up to (and including) the
   * N-th user turn is dropped; the conversation continues from the
   * (N-1)-th user turn's replies. Returns the number of removed events.
   */
  rewind(userTurnsToDrop: number): number {
    const raw = fs.readFileSync(this.file, 'utf8');
    const lines = raw.split('\n');
    let seenUser = 0;
    let cut = -1;
    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]) as { type?: string; text?: string };
        if (parsed.type === 'user') {
          seenUser++;
          if (seenUser > userTurnsToDrop) {
            cut = i;
            break;
          }
          // skip to the last non-user event belonging to this turn
          while (i + 1 < lines.length) {
            try {
              const next = JSON.parse(lines[i + 1]) as { type?: string };
              if (next.type === 'user') break;
              i++;
            } catch {
              i++;
            }
          }
        }
      } catch {
        /* skip unparsable */
      }
    }
    if (cut === -1) return 0;
    const removed = lines.slice(cut).filter((line) => line.trim()).length;
    fs.writeFileSync(this.file, lines.slice(0, cut).join('\n').trimEnd() + '\n', 'utf8');
    return removed;
  }

  /** Write the transcript as human-readable markdown. */
  exportMarkdown(target: string): string {
    const events = this.readEvents();
    const parts = [`# Ardan session ${this.id}`, '', `cwd: ${this.cwd}`, ''];
    for (const event of events) {
      if (event.type === 'user') {
        parts.push('## User', '', String(event.text || ''), '');
      } else if (event.type === 'assistant') {
        parts.push('## Ardan', '', String(event.text || ''), '');
      } else if (event.type === 'tool_result') {
        parts.push(`> tool ${String(event.toolName || '')} -> ${event.ok ? 'ok' : 'error'}: ${String(event.output || '').slice(0, 300)}`, '');
      } else if (event.type === 'summary') {
        parts.push('## Summary', '', String(event.text || ''), '');
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, parts.join('\n'), 'utf8');
    return target;
  }

  readEvents(): SessionEvent[] {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as SessionEvent & { type: 'meta' | SessionEvent['type'] };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is SessionEvent & Record<string, unknown> => Boolean(entry))
        .filter((entry) => entry.type !== 'meta');
    } catch {
      return [];
    }
  }

  /** Replay events into a ChatMessage[] conversation. */
  replay(): ChatMessage[] {
    const history: ChatMessage[] = [];
    for (const event of this.readEvents()) {
      if (event.type === 'user') {
        history.push({ role: 'user', content: event.text || '' });
      } else if (event.type === 'assistant') {
        history.push({
          role: 'assistant',
          content: event.text || '',
          toolCalls: (event.toolCalls || []) as ToolCall[],
        });
      } else if (event.type === 'tool_result') {
        history.push({
          role: 'tool',
          toolCallId: event.toolCallId || '',
          content: `[${event.ok ? 'OK' : 'ERROR'}] ${event.output || ''}`,
        });
      } else if (event.type === 'summary') {
        history.push({ role: 'user', content: `[summary of older work] ${event.text}` });
      }
    }
    return history;
  }

  compact(): void {
    const events = this.readEvents();
    const keep = events.slice(-40);
    fs.writeFileSync(this.file, '', 'utf8');
    this.append({ type: 'summary', text: `${events.length - keep.length} older events trimmed` });
    for (const event of keep) this.appendEvent(event);
  }

  static list(cwd: string): SessionMeta[] {
    const dir = projectDir(cwd);
    try {
      const files = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => {
          const full = path.join(dir, file);
          const stat = fs.statSync(full);
          const raw = fs.readFileSync(full, 'utf8');
          const lines = raw.split('\n').filter((line) => line.trim());
          let preview = '';
          let title: string | undefined;
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'custom-title' && parsed.customTitle) {
                title = String(parsed.customTitle);
              }
              if (parsed.type === 'user' && parsed.text && !preview) {
                preview = String(parsed.text).slice(0, 70);
              }
              if (title && preview) break;
            } catch {
              /* ignore */
            }
          }
          return {
            id: file.replace('.jsonl', ''),
            file: full,
            created: stat.birthtime.toISOString(),
            updated: stat.mtime.toISOString(),
            events: lines.length,
            preview: title ? `${title} — ${preview || '(no prompt yet)'}` : preview || '(empty)',
          } satisfies SessionMeta;
        })
        .sort((a, b) => b.updated.localeCompare(a.updated));
      return files;
    } catch {
      return [];
    }
  }
}
