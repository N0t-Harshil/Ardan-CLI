// Tool registry - the full openclaude-style catalog.
import type { ToolContext, ToolDef } from '../types.ts';
import { bashTool, powershellTool } from './bash.ts';
import { editTool, listDirTool, readTool, writeTool } from './files.ts';
import { globTool, grepTool } from './globgrep.ts';
import { sleepTool, taskTool, todoTool, webFetchTool, webSearchTool } from './misc.ts';
import { taskOutputTool, taskStopTool, monitorTool } from './background.ts';
import { discoverSkillsTool, toolSearchTool } from './searchtools.ts';
import {
  askUserTool,
  enterPlanModeTool,
  exitPlanModeTool,
} from './interactive.ts';
import {
  ctxInspectTool,
  listMcpResourcesTool,
  nodeReplTool,
  notebookEditTool,
  readMcpResourceTool,
  repoMapTool,
} from './inspect.ts';
import { taskTools } from './tasks.ts';
import { enterWorktreeTool, exitWorktreeTool } from './worktree.ts';
import { skillTool } from './skillstool.ts';
import { cronTools } from '../plugins/scheduler.ts';
import type { McpServer } from './mcp.ts';
import type { SkillDef } from '../plugins/loader.ts';
import { diagnosticsTool, type LspServerConfig } from './lsp.ts';

export { globToRegExp } from './globgrep.ts';
export { mcpToolDefs, McpServer } from './mcp.ts';
export type { McpToolInfo } from './mcp.ts';
export type { LspServerConfig } from './lsp.ts';

/** Tools that run without a permission prompt (read-only-ish). */
export function readonlyTools(all: ToolDef[]): ToolDef[] {
  return all.filter((tool) => tool.permission === 'auto');
}

/**
 * Runs a sub-agent and returns its final report. The REPL provides the
 * implementation (provider, agent catalog, tool filtering).
 */
export type SubLoopFn = (options: {
  prompt: string;
  agent?: string;
  ctx: ToolContext;
}) => Promise<string>;

/** Tools allowed while plan mode is on (research + plan control). */
export const PLAN_ALLOWED = new Set([
  'Read', 'Glob', 'Grep', 'ListDir', 'WebFetch', 'WebSearch',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'RepoMap', 'CtxInspect', 'Skill', 'TaskList', 'TaskGet',
  'Sleep', 'ToolSearch', 'DiscoverSkills', 'Diagnostics',
]);

export function buildToolRegistry(
  subLoop: SubLoopFn,
  options: {
    planMode?: boolean;
    extra?: ToolDef[];
    agents?: Array<{ name: string }>;
    skills?: SkillDef[];
    mcpServers?: McpServer[];
    lspServers?: Array<{ name: string; config: LspServerConfig }>;
  } = {},
): ToolDef[] {
  const core: ToolDef[] = [
    readTool(),
    globTool(),
    grepTool(),
    listDirTool(),
    bashTool(),
    powershellTool(),
    writeTool(),
    editTool(),
    todoTool(),
    webFetchTool(),
    webSearchTool(),
    taskTool(
      subLoop,
      (options.agents || []).map((agent) => agent.name),
    ),
    taskOutputTool(),
    taskStopTool(),
    monitorTool(),
    sleepTool(),
    askUserTool(),
    enterPlanModeTool(),
    exitPlanModeTool(),
    repoMapTool(),
    nodeReplTool(),
    notebookEditTool(),
    ctxInspectTool(),
    toolSearchTool(),
    discoverSkillsTool(options.skills || []),
    ...taskTools(),
    ...cronTools(),
    enterWorktreeTool(),
    exitWorktreeTool(),
  ];
  core.push(skillTool(options.skills || []));
  if (options.mcpServers?.length) {
    const wrappers = options.mcpServers.map((server) => ({
      serverName: server.serverName,
      request: (method: string, params: Record<string, unknown>) =>
        server.request(method, params),
    }));
    core.push(listMcpResourcesTool(wrappers), readMcpResourceTool(wrappers));
  }
  if (options.lspServers?.length) core.push(diagnosticsTool(options.lspServers));
  if (options.extra?.length) core.push(...options.extra);

  if (options.planMode) {
    return core.filter((tool) =>
      PLAN_ALLOWED.has(tool.name) || tool.name.startsWith('mcp__ListMcpResources'),
    );
  }
  return core;
}
