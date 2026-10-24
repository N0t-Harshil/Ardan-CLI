// Plugin discovery: frontmatter loader, custom slash commands, subagents,
// skills - the openclaude conventions:
//   .ardan/commands/*.md   (project + ~/.ardan/commands)
//   .ardan/agents/*.md
//   <skill-dir>/SKILL.md   (.ardan/skills/*, ~/.ardan/skills/*)
// Project files take precedence over user files on name collision.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/** Parse an optional '--- ... ---' YAML-lite frontmatter block. */
export function parseFrontmatter(markdown: string): Frontmatter {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) {
    return { data: {}, body: normalized };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const data: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match) data[match[1].toLowerCase()] = match[2].trim();
  }
  return { data, body };
}

export function substituteArguments(body: string, argText: string): string {
  const parts = argText.split(/\s+/).filter(Boolean);
  return body
    .replace(/\$ARGUMENTS\b/g, argText)
    .replace(/\$(\d+)/g, (_all, n: string) => (n === '0' ? argText : parts[Number(n) - 1] ?? ''));
}

/* ---------------------------------------------------------- commands */

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  file: string;
}

export function loadCommands(workdir: string): CustomCommand[] {
  const sources = [
    path.join(os.homedir(), '.ardan', 'commands'),
    path.join(workdir, '.ardan', 'commands'),
  ];
  const byName = new Map<string, CustomCommand>();
  for (const dir of sources) {
    for (const entry of listMarkdown(dir)) {
      try {
        const raw = fs.readFileSync(entry, 'utf8');
        const { data, body } = parseFrontmatter(raw);
        const name = path.basename(entry, '.md').toLowerCase();
        byName.set(name, {
          name,
          description: data.description || `custom command (${entry})`,
          prompt: preprocessPrompt(body),
          file: entry,
        });
      } catch {
        /* unreadable - skipped */
      }
    }
  }
  return [...byName.values()];
}

/**
 * Commands can inject shell output inline (! cmd) for static lookups.
 * Registered as a lazy loader to keep the prompt factory pure.
 */
function preprocessPrompt(body: string): string {
  const SHELL_RE = /^! (.*)$/gm;
  return body
    .split('\n')
    .map((line) => {
      const match = SHELL_RE.exec(line);
      SHELL_RE.lastIndex = 0;
      if (!match) return line;
      const command = match[1].trim();
      try {
        const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
        return execSync(shell, {
          args,
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch (error) {
        return `[command failed: ${(error as Error).message.slice(0, 120)}]`;
      }
    })
    .join('\n');
}

function listMarkdown(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------ output styles */

export interface OutputStyle {
  name: string;
  description: string;
  body: string;
  keepCodingInstructions: boolean;
}

export function loadOutputStyles(workdir: string): OutputStyle[] {
  const sources = [
    path.join(os.homedir(), '.ardan', 'output-styles'),
    path.join(workdir, '.ardan', 'output-styles'),
  ];
  const byName = new Map<string, OutputStyle>();
  for (const dir of sources) {
    for (const entry of listMarkdown(dir)) {
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(entry, 'utf8'));
        const name = (data.name || path.basename(entry, '.md')).toLowerCase();
        byName.set(name, {
          name,
          description: data.description || `output style (${entry})`,
          body: body.trim(),
          keepCodingInstructions: (data['keep-coding-instructions'] || 'true').toLowerCase() !== 'false',
        });
      } catch {
        /* unreadable - skipped */
      }
    }
  }
  return [...byName.values()];
}

/* ----------------------------------------------------------- agents */

export interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
  permissionMode?: 'default' | 'bypassPermissions';
  prompt: string;
}

export function loadAgents(workdir: string): AgentDef[] {
  const sources = [
    path.join(os.homedir(), '.ardan', 'agents'),
    path.join(workdir, '.ardan', 'agents'),
  ];
  const byName = new Map<string, AgentDef>();
  for (const dir of sources) {
    for (const entry of listMarkdown(dir)) {
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(entry, 'utf8'));
        const name = (data.name || path.basename(entry, '.md')).toLowerCase();
        const toolsField = data.tools?.split(',').map((t) => t.trim()).filter(Boolean);
        byName.set(name, {
          name,
          description: data.description || `custom subagent (${name})`,
          tools: toolsField && toolsField.length ? toolsField : undefined,
          model: data.model && data.model !== 'inherit' ? data.model : undefined,
          maxTurns: data.maxturns ? Number(data.maxturns) : undefined,
          permissionMode: data.permissionmode === 'bypassPermissions' ? 'bypassPermissions' : 'default',
          prompt: body.trim(),
        });
      } catch {
        /* unreadable - skipped */
      }
    }
  }
  return [...byName.values()];
}

/* ----------------------------------------------------------- skills */

export interface SkillDef {
  name: string;
  description: string;
  file: string;
  dir: string;
  allowedTools: string[];
  userInvocable: boolean;
}

export function loadSkills(workdir: string): SkillDef[] {
  const sources = [
    path.join(os.homedir(), '.ardan', 'skills'),
    path.join(workdir, '.ardan', 'skills'),
  ];
  const byName = new Map<string, SkillDef>();
  for (const root of sources) {
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const skillFile = path.join(dir, 'SKILL.md');
      try {
        const { data } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
        const name = (data.name || path.basename(dir)).toLowerCase();
        byName.set(name, {
          name,
          description: data.description || data.when_to_use || `(no description) ${skillFile}`,
          file: skillFile,
          dir,
          allowedTools: (data['allowed-tools'] || '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          userInvocable: (data['user-invocable'] || 'true').toLowerCase() !== 'false',
        });
      } catch {
        /* no SKILL.md in dir - skipped */
      }
    }
  }
  return [...byName.values()];
}
