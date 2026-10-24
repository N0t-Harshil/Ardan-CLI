// ToolSearch (progressive tool discovery) + DiscoverSkills.
import type { ToolDef } from '../types.ts';
import type { SkillDef } from '../plugins/loader.ts';

export function toolSearchTool(): ToolDef {
  return {
    name: 'ToolSearch',
    description:
      'Search the tool catalog by keyword or fetch exact tools with select:Name1,Name2. ' +
      'Returns name + full description for each match so unknown MCP tools can be discovered.',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, or select:A,select:B to list exact tools.' },
        max_results: { type: 'number', description: 'Matches per search (default 5).' },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const catalog = (ctx.state.get('catalogRef') as ToolDef[]) || [];
      const raw = String(args.query || '').trim();
      if (!raw) return { ok: false, output: 'query is required' };
      if (!catalog.length) return { ok: false, output: 'tool catalog not available yet' };

      let matches: ToolDef[];
      if (raw.startsWith('select:')) {
        const names = raw.slice('select:'.length).split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
        matches = names
          .map((name) => catalog.find((tool) => tool.name.toLowerCase() === name))
          .filter((tool): tool is ToolDef => Boolean(tool));
      } else {
        const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
        const scored = catalog
          .map((tool) => {
            const name = tool.name.toLowerCase();
            const description = tool.description.toLowerCase();
            let score = 0;
            for (const token of tokens) {
              if (name.includes(token)) score += 3;
              else if (description.includes(token)) score += 1;
            }
            return { tool, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        const limit = Math.max(1, Math.min(Number(args.max_results) || 5, 15));
        matches = scored.slice(0, limit).map((entry) => entry.tool);
      }
      if (!matches.length) return { ok: true, output: 'No matching tools found.' };
      return {
        ok: true,
        output: matches.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n'),
      };
    },
    renderCall(args) {
      return `ToolSearch(${String(args.query || '').slice(0, 50)})`;
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: outcome.output.split('\n').length > 1 ? `${outcome.output.split('\n').length} matches` : outcome.output.slice(0, 100) };
    },
  };
}

export function discoverSkillsTool(skills: SkillDef[]): ToolDef {
  return {
    name: 'DiscoverSkills',
    description: 'List installed skills (playbooks loadable via the Skill tool) with their descriptions.',
    permission: 'auto',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      if (!skills.length) {
        return {
          ok: true,
          output: 'No skills installed. Add .ardan/skills/<name>/SKILL.md (frontmatter: name, description).',
        };
      }
      return {
        ok: true,
        output: skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n'),
      };
    },
    renderCall() {
      return 'DiscoverSkills()';
    },
    renderResult(outcome) {
      return { ok: outcome.ok, text: `${outcome.output.split('\n').length} skills` };
    },
  };
}
