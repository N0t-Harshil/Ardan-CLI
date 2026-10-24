// Skill tool: loads a SKILL.md playbook on demand.
import fs from 'node:fs';
import type { ToolDef } from '../types.ts';
import type { SkillDef } from '../plugins/loader.ts';

const MAX_SKILL_CHARS = 10_000;

export function skillTool(skills: SkillDef[]): ToolDef {
  return {
    name: 'Skill',
    description:
      'Load a skill playbook (SKILL.md) for a domain task - coding conventions, workflows, recipes the project installed under .ardan/skills. Returns the full instructions to follow.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name (see /skills).' } },
      required: ['name'],
    },
    async run(args) {
      const name = String(args.name || '').toLowerCase();
      if (!name) return { ok: false, output: `name is required. available: ${skills.map((s) => s.name).join(', ') || '(none installed)'}` };
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return {
          ok: false,
          output: `unknown skill '${name}'. available: ${skills.map((s) => s.name).join(', ') || '(none installed)'}`,
        };
      }
      try {
        const raw = fs.readFileSync(skill.file, 'utf8');
        const clipped = raw.length > MAX_SKILL_CHARS ? raw.slice(0, MAX_SKILL_CHARS) + '\n...[clipped]' : raw;
        return { ok: true, output: `[skill: ${skill.name}]\n${clipped}` };
      } catch (error) {
        return { ok: false, output: `cannot read ${skill.file}: ${(error as Error).message}` };
      }
    },
    renderCall(args) {
      return `Skill(${String(args.name || '')})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.ok ? `loaded skill` : outcome.output.slice(0, 150) };
    },
  };
}
