// Interactive REPL — openclaude/Claude-Code-style: streaming answers,
// tool-call trace, slash commands, @file mentions, !shell passthrough.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { runAgentLoop, systemPrompt } from './agent.ts';
import {
  LiveRenderer,
  askPermission,
  color,
  cyan,
  dim,
  green,
  red,
  yellow,
} from './render.ts';
import { bashTool } from './tools/bash.ts';
import {
  McpServer,
  readonlyTools,
  buildToolRegistry,
  mcpToolDefs,
  type SubLoopFn,
} from './tools/index.ts';
import { readTasks } from './tools/tasks.ts';
import { askUserTool, type AskUserFn } from './tools/interactive.ts';
import {
  parseFrontmatter,
  loadAgents,
  loadCommands,
  loadSkills,
  loadOutputStyles,
  substituteArguments,
  type AgentDef,
  type CustomCommand,
  type SkillDef,
} from './plugins/loader.ts';
import { checkDue } from './plugins/scheduler.ts';
import { monitorNewData, pendingBgNotifications } from './tools/background.ts';
import { restoreFileHistory, restoreFileHistoryAt } from './tools/files.ts';
import {
  describeHookBlock,
  hookMatches,
  hooksFor,
  runHook,
} from './plugins/hooks.ts';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { autoPickProvider, createProvider, loadSettings, saveSettings, settingsPath } from './config.ts';
import os from 'node:os';
import { SessionStore, type SessionMeta } from './session.ts';
import type {
  ChatMessage,
  PermissionAnswer,
  Provider,
  Settings,
  ToolContext,
  ToolDef,
} from './types.ts';

const SLASH_COMMANDS = [
  '/help', '/plan', '/model', '/provider', '/tools', '/stats', '/context', '/cost',
  '/sessions', '/resume', '/clear', '/compact', '/memory', '/init', '/exit',
  '/tasks', '/agents', '/skills', '/plugins', '/hooks', '/mcp', '/doctor',
  '/diff', '/copy', '/export', '/rename', '/rewind', '/goal', '/brief',
  '/review', '/security-review', '/search', '/config', '/schedule', '/output-style',
];

export interface ReplOptions {
  workdir: string;
  providerName?: string;
  modelOverride?: string;
  resumeId?: string;
  continueFlag?: boolean;
  autoYes?: boolean;
  planMode?: boolean;
  oneShot?: string;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const settings: Settings = loadSettings();
  const workdir = options.workdir;
  const isTTY = Boolean(process.stdout.isTTY);
  let providerName =
    options.providerName || settings.defaultProvider || autoPickProvider(settings);

  let provider: Provider;
  try {
    provider = createProvider(providerName, options.modelOverride, settings);
  } catch (error) {
    console.error(red(`✖ ${(error as Error).message}`));
    process.exitCode = 1;
    return;
  }

  let planMode = Boolean(options.planMode);
  const autoYes = Boolean(options.autoYes);
  const grants = new Set<string>();
  const mcpServers: McpServer[] = [];
  const mcpTools: ToolDef[] = [];
  let activeWorkdir = workdir;

  /* ------------------------------------------------------------- MCP */
  for (const [name, config] of Object.entries(settings.mcpServers || {})) {
    const server = new McpServer(name, config.command, config.args || [], config.env);
    try {
      const infos = await server.connect();
      mcpTools.push(...mcpToolDefs(server, infos));
      mcpServers.push(server);
      console.log(cyan(`  ◆ MCP '${name}' connected`), dim(`(${infos.length} tools)`));
    } catch (error) {
      console.error(dim(`  ✖ MCP '${name}' failed: ${(error as Error).message}`));
      server.stop();
    }
  }

  /* -------------------------------------- plugins: commands/agents/skills */
  const plugins: {
    commands: CustomCommand[];
    agents: AgentDef[];
    skills: SkillDef[];
  } = {
    commands: loadCommands(workdir),
    agents: loadAgents(workdir),
    skills: loadSkills(workdir),
  };
  const pluginCount = plugins.commands.length + plugins.agents.length + plugins.skills.length;
  if (pluginCount) {
    console.log(
      dim(
        `  ◆ plugins: ${plugins.commands.length} commands, ${plugins.agents.length} subagents, ${plugins.skills.length} skills`,
      ),
    );
  }

  /* ------------------------------------------------- history + tools */
  const history: ChatMessage[] = [];
  const sharedState = new Map<string, unknown>();
  let tools: ToolDef[] = [];
  const baseToolsRef = { current: [] as ToolDef[] };
  const activeProvider = { current: provider };
  let rendererRef: { setSuppressedNames(names: string[]): void } | undefined;

  const activeDir = (): string => activeWorkdir;

  const DEFAULT_SUB_AGENT = (cwd: string): string =>
    `You are a focused sub-agent spawned by the Task tool, researching/working in: ${cwd}. ` +
    'Investigate with your available tools and reply with a concise, complete final report (no tool chatter).';

  const subLoop: SubLoopFn = async ({ prompt, agent, ctx }) => {
    let system = DEFAULT_SUB_AGENT(ctx.workdir);
    let subTools: ToolDef[] = readonlyTools(baseToolsRef.current);
    let useProvider = activeProvider.current;
    const agentDef = agent
      ? plugins.agents.find((a) => a.name === agent.toLowerCase())
      : undefined;
    if (agent && !agentDef) {
      return `No subagent named '${agent}'. Available: ${plugins.agents.map((a) => a.name).join(', ') || '(none installed)'}`;
    }
    if (agentDef) {
      if (agentDef.prompt) system = `${agentDef.prompt}\n\nWorking directory: ${ctx.workdir}`;
      if (agentDef.tools?.length) {
        subTools = agentDef.tools
          .map((name) =>
            baseToolsRef.current.find((tool) => tool.name.toLowerCase() === name.toLowerCase()),
          )
          .filter((tool): tool is ToolDef => Boolean(tool));
      }
      if (agentDef.model) {
        try {
          useProvider = createProvider(providerName, agentDef.model, settings);
        } catch {
          /* keep main provider */
        }
      }
    }
    const result = await runAgentLoop({
      provider: useProvider,
      tools: subTools,
      history: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      input: '',
      workdir: ctx.workdir,
      maxTurns: agentDef?.maxTurns || 8,
      permissionGate: async () => true,
      onEvent: (event) => {
        if (event.type === 'error') console.log(dim(`    ✖ sub-agent: ${event.text}`));
      },
      signal: ctx.signal,
    });
    return result.text || '(sub-agent returned nothing)';
  };

  const buildSystem = (): void => {
    history[0] = {
      role: 'system',
      content: systemPrompt({
        workdir: activeDir(),
        providerLabel: `${providerName} (${activeProvider.current.model})`,
        tools,
        planMode,
        memory: readMemory(activeDir()),
        agentsSummary: plugins.agents.length
          ? plugins.agents.map((a) => `  - ${a.name}: ${a.description}`).join('\n')
          : undefined,
        skillsSummary: plugins.skills.length
          ? plugins.skills.map((s) => `  - ${s.name}: ${s.description}`).join('\n')
          : undefined,
        outputStyle: activeOutputStyle(),
      }),
    };
  };

  const outputStyles = loadOutputStyles(workdir);
  let activeStyleName: string | undefined;
  const activeOutputStyle = (): string | undefined => {
    if (!activeStyleName || activeStyleName === 'default') return undefined;
    const style = outputStyles.find((entry) => entry.name === activeStyleName);
    if (!style) return undefined;
    return style.keepCodingInstructions
      ? `OUTPUT STYLE '${style.name}' - shape every response to match these instructions:\n${style.body}`
      : `OUTPUT STYLE '${style.name}' - these instructions define how you respond and may adjust the base guidance:\n${style.body}`;
  };

  const rebuildTools = (): void => {
    const lspServers = Object.entries(settings.lspServers || {}).map(([name, config]) => ({
      name,
      config,
    }));
    baseToolsRef.current = buildToolRegistry(subLoop, {
      planMode: false,
      extra: mcpTools,
      agents: plugins.agents,
      skills: plugins.skills,
      mcpServers,
      lspServers,
    });
    tools = planMode
      ? buildToolRegistry(subLoop, {
          planMode: true,
          agents: plugins.agents,
          skills: plugins.skills,
          lspServers,
        })
      : baseToolsRef.current;
    sharedState.set('toolNames', tools.map((tool) => tool.name));
    sharedState.set('catalogRef', baseToolsRef.current);
    rendererRef?.setSuppressedNames(tools.map((tool) => tool.name));
    buildSystem();
  };

  const resumeStore = (): SessionStore => {
    let id = options.resumeId;
    if (!id) id = SessionStore.list(workdir)[0]?.id;
    if (!id) {
      console.log(dim('No previous session found; starting fresh.'));
      return new SessionStore(workdir);
    }
    console.log(cyan(`  ● resuming session ${id}`));
    return new SessionStore(workdir, id);
  };

  let store =
    options.resumeId || options.continueFlag ? resumeStore() : new SessionStore(workdir);

  rebuildTools();
  if (options.resumeId || options.continueFlag) {
    history.push(...store.replay());
  }
  store.appendMeta(providerName, activeProvider.current.model, planMode);
  let sessionGoal = store.latestGoal();

  const renderer = new LiveRenderer();
  rendererRef = renderer;
  rendererRef.setSuppressedNames(tools.map((tool) => tool.name));

  /* ------------------------------------------------------ SessionStart */
  for (const entry of hooksFor(settings, 'SessionStart')) {
    const result = await runHook(
      entry,
      { event: 'SessionStart', session: store.id, cwd: activeWorkdir },
      activeWorkdir,
    );
    if (result.systemMessage) console.log(dim(`  ⚑ ${result.systemMessage}`));
  }

  /* --------------------------------- idle poller: bg tasks + scheduler */
  let turnRunning = false;
  const poller = setInterval(() => {
    if (turnRunning) return;
    const probe = { workdir: activeWorkdir, sessionId: store.id, signal: new AbortController().signal, state: sharedState };
    if (!process.env.ARDAN_DISABLE_TASK_NOTIFICATIONS) {
      const fresh = pendingBgNotifications(probe);
      for (const task of fresh) {
        const tail = task.stdout.trim().slice(-600) || task.stderr.trim().slice(-600) || '(empty output)';
        console.log(dim(`  ◔ task ${task.id} finished (exit ${task.code ?? 'signal'})`));
        history.push({
          role: 'user',
          content: `[task-notification] background task ${task.id} (${task.command}) finished with exit ${task.code ?? 'signal'}:\n${tail}`,
        });
      }
      for (const { task, delta } of monitorNewData(probe)) {
        const tail = delta.trimEnd().slice(-600);
        console.log(dim(`  ◔ monitor ${task.id}: new output (${tail.split('\n').length} line(s))`));
        history.push({
          role: 'user',
          content: `[monitor-notification] task ${task.id} (${task.command}) produced new output:\n${tail}`,
        });
      }
    }
    if (!process.env.ARDAN_DISABLE_CRON) {
      checkDue(activeWorkdir).forEach((task) => {
        console.log(cyan(`  ⏰ scheduled task ${task.id} firing now`));
        void runTurn(`[scheduled task ${task.id}]\n${task.prompt}`);
      });
    }
  }, 2000);

  /* ------------------------------------------------------- permissions */
  const permissionGate = async (
    tool: ToolDef,
    args: Record<string, unknown>,
  ): Promise<boolean> => {
    for (const entry of hooksFor(settings, 'PreToolUse')) {
      if (!hookMatches(entry, tool.name)) continue;
      const result = await runHook(
        entry,
        { event: 'PreToolUse', tool: tool.name, args, session: store.id, cwd: activeWorkdir },
        activeWorkdir,
      );
      if (result.blocked) {
        console.log(
          red(`  ✖ ${tool.name} blocked by PreToolUse hook`),
          dim(`— ${describeHookBlock(result).slice(0, 140)}`),
        );
        return false;
      }
      if (result.systemMessage) console.log(yellow(`  ⚑ ${result.systemMessage}`));
    }
    if (autoYes || settings.permissions === 'bypass') return true;
    if (tool.permission === 'auto') return true;
    if (tool.permission === 'write' && settings.permissions === 'acceptEdits') return true;
    const category =
      tool.permission === 'mcp' ? `mcp:${tool.name.split('__')[1]}` : String(tool.permission);
    if (grants.has(category)) return true;
    if (!process.stdin.isTTY) return false;
    const answer: PermissionAnswer = await askPermission(tool.name, tool.renderCall(args), false);
    if (answer === 'always') {
      grants.add(category);
      return true;
    }
    return answer === 'allow';
  };

  /* --------------------------------------------------------- ask picker */
  const askAnswer: AskUserFn = async (question, options, multi) => {
    if (!process.stdin.isTTY) throw new Error('AskUserQuestion needs an interactive terminal');
    console.log(`\n  ${bold('?')} ${bold(question)}`);
    options?.forEach((option, index) => {
      console.log(`    ${cyan(`${index + 1})`)} ${option}`);
    });
    console.log(
      dim(
        options?.length
          ? multi
            ? '    enter comma-separated numbers (or your own text)'
            : '    enter a number (or your own text)'
          : '    type your answer',
      ),
    );
    const raw = (await readUserLine(color('96', '    > '))).trim();
    if (!raw) return '(no answer given)';
    if (options?.length) {
      const numbers = raw.split(',');
      const mapped = numbers
        .map((part) => part.trim())
        .map((part) => (/^\d+$/.test(part) ? options[Number(part) - 1] : part))
        .filter(Boolean);
      if (!mapped.length) return raw;
      return multi ? mapped.join(' | ') : mapped[0] as string;
    }
    return raw;
  };

  /* --------------------------------------- plan/worktree mode switching */
  const applyStateRequests = async (): Promise<void> => {
    if (sharedState.has('planModeRequest')) {
      const want = Boolean(sharedState.get('planModeRequest'));
      sharedState.delete('planModeRequest');
      if (want !== planMode) {
        if (
          !want &&
          !autoYes &&
          process.stdin.isTTY
        ) {
          console.log(yellow('\n  ◇ plan ready — approve implementation?'));
          let approved = false;
          for (let attempt = 0; attempt < 3 && !approved; attempt++) {
            const answer = (await readUserLine(color('96', '  [y] approve / [n] keep planning > '))).trim().toLowerCase();
            if (answer === 'y' || answer === 'yes') {
              approved = true;
              break;
            }
            if (answer === 'n' || answer === 'no' || answer === '') {
              break;
            }
          }
          if (!approved) {
            console.log(dim('  staying in plan mode — tell the model what to refine'));
            return;
          }
        }
        planMode = want;
        rebuildTools();
        console.log(
          want
            ? yellow('  ◇ plan mode ON (EnterPlanMode) — research only until ExitPlanMode')
            : green('  ◆ plan mode OFF (ExitPlanMode) — say "go" to implement'),
        );
      }
    }
    if (sharedState.has('workdirRequested')) {
      const target = String(sharedState.get('workdirRequested'));
      sharedState.delete('workdirRequested');
      if (fs.existsSync(target) && target !== activeWorkdir) {
        activeWorkdir = target;
        rebuildTools();
        console.log(cyan(`  ⇄ workdir → ${dim(target)}`));
      }
    }
  };

  /* -------------------------------------------- PostToolUse hook runner */
  const firePostHooks = async (
    tool: string,
    args: unknown,
    outcome: { ok: boolean },
  ): Promise<void> => {
    for (const entry of hooksFor(settings, 'PostToolUse')) {
      if (!hookMatches(entry, tool)) continue;
      const result = await runHook(
        entry,
        { event: 'PostToolUse', tool, args, session: store.id, cwd: activeWorkdir },
        activeWorkdir,
      );
      if (result.systemMessage) console.log(dim(`  ⚑ ${result.systemMessage}`));
      void outcome;
    }
  };

  /* ---------------------------------------------------------- run turn */
  let lastAssistantText = '';
  const runTurn = async (input: string, prefix?: string): Promise<void> => {
    const fullPrefix = [
      sessionGoal ? `[active goal: ${sessionGoal} — steer replies and steps toward it; /goal stop clears it]` : undefined,
      prefix,
    ]
      .filter(Boolean)
      .join('\n\n');
    turnRunning = true;
    for (const entry of hooksFor(settings, 'UserPromptSubmit')) {
      const hookResult = await runHook(
        entry,
        { event: 'UserPromptSubmit', prompt: input, session: store.id, cwd: activeWorkdir },
        activeWorkdir,
      );
      if (hookResult.blocked) {
        console.log(red(`  ✖ submit blocked by hook — ${describeHookBlock(hookResult).slice(0, 140)}`));
        return;
      }
    }
    sharedState.set('ask', askAnswer);
    const turnIndex = Number(sharedState.get('turnIndex') || 0) + 1;
    sharedState.set('turnIndex', turnIndex);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    try {
      renderer.startTurn();
      const result = await runAgentLoop({
        provider: activeProvider.current,
        tools,
        history,
        input,
        extraContextPrefix: fullPrefix || undefined,
        workdir: activeWorkdir,
        permissionGate,
        onEvent: (event) => renderer.event(event),
        onAssistantTurn: (turn) => {
          store.appendEvent({ type: 'assistant', text: turn.text, toolCalls: turn.toolCalls });
          if (turn.text.trim()) lastAssistantText = turn.text.trim();
        },
        onToolResult: ({ call, outcome }) => {
          store.appendEvent({
            type: 'tool_result',
            toolCallId: call.id,
            toolName: call.name,
            ok: outcome.ok,
            output: outcome.output.slice(0, 4000),
          });
          void firePostHooks(call.name, call.args, outcome);
        },
        signal: controller.signal,
        state: sharedState,
      });
      renderer.finishTurn();
      if (result.aborted) console.log(yellow('\n  ⏹ interrupted — type your next message'));
    } finally {
      process.removeListener('SIGINT', onSigint);
      await applyStateRequests();
      turnRunning = false;
    }
  };

  /* -------------------------------------------------- @file / ! shell */
  const expandMentions = (text: string): string | undefined => {
    const mentions = [...text.matchAll(/@([\w.\-./\\]+)/g)];
    if (!mentions.length) return undefined;
    const blocks: string[] = [];
    for (const [, raw] of mentions) {
      const file = path.resolve(activeWorkdir, raw.replace(/^[/\\]/, ''));
      try {
        const stat = fs.statSync(file);
        if (stat.size > 64 * 1024) {
          blocks.push(`[Attached: ${raw} — too large (${stat.size}b); use the Read tool on it instead]`);
          continue;
        }
        blocks.push(`[Attached file: ${raw}]\n${fs.readFileSync(file, 'utf8')}`);
      } catch {
        blocks.push(`[Attached: ${raw} — not found (relative paths resolve from ${activeWorkdir})]`);
      }
    }
    return blocks.join('\n\n');
  };

  const runShell = async (command: string): Promise<void> => {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    try {
      const outcome = await bashTool().run(
        { command, timeout: 300 },
        { workdir: activeWorkdir, sessionId: store.id, signal: controller.signal, state: sharedState } satisfies ToolContext,
      );
      console.log(outcome.ok ? outcome.output : red(outcome.output));
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  };

  /* ------------------------------------------------------ slash commands */
  const SLASH_HELP = [
    `${color('1', 'Slash commands')}`,
    `  /plan [on|off]     toggle plan mode (EnterPlanMode/ExitPlanMode work too)`,
    `  /model <name>      switch model (no arg: list models)`,
    `  /provider <name>   switch provider`,
    `  /tools             list active tools`,
    `  /stats /context    session + context-window breakdown`,
    `  /effort low|medium|high   set reasoning effort (OpenAI-compatible)`,
    `  /permissions [mode]        view/set permission mode (default/ask/acceptEdits/bypass)`,
    `  /cost              token usage estimate for this session`,
    `  /diff              what changed in this project (git + file history)`,
    `  /copy              copy the last Ardan reply to the clipboard`,
    `  /export [file]     dump the transcript as markdown`,
    `  /rename <title>    rename this session (shows in /sessions)`,
    `  /rewind [n] [files] continue from user turn n+1 (keeps 1..n); 'files' rolls back changes turns > n made`,
    `  /goal <text|stop|status>  persistent goal injected in every turn`,
    `  /brief             catch-me-up summary of this session`,
    `  /review  /security-review   guided review passes of the current diff`,
    `  /search <query>    quick web lookup through the agent`,
    `  /config            open ~/.ardan/settings.json in your editor`,
    `  /schedule          planned prompts (cron: CronCreate/CronDelete)`,
    `  /output-style [n]  list/set an output style (.ardan/output-styles)`,
    `  /sessions /resume /clear /compact /tasks /memory /init`,
    `  /agents /skills /plugins /hooks /mcp /doctor /exit`,
    '',
    `${dim('Custom commands/skills from .ardan/commands and .ardan/skills are callable as /name args')}`,
    `${dim('Tips: @file attaches  •  !cmd runs shell  •  Ctrl+C interrupts')}`,
  ].join('\n');

  const exitRepl = (code = 0): never => {
    clearInterval(poller);
    for (const entry of hooksFor(settings, 'SessionEnd')) {
      try {
        const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', entry.command] : ['-c', entry.command];
        spawnSync(shell, args, {
          cwd: activeWorkdir,
          input: JSON.stringify({ event: 'SessionEnd', session: store.id, cwd: activeWorkdir }),
          timeout: (entry.timeout || 20) * 1000,
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
        });
      } catch {
        /* best effort */
      }
    }
    for (const server of mcpServers) server.stop();
    if (process.stdout.isTTY) console.log(dim('\nSession saved. Bye!'));
    process.exit(code);
  };

  const switchProvider = (name: string): void => {
    providerName = name;
    try {
      provider = createProvider(providerName, undefined, settings);
      activeProvider.current = provider;
      rebuildTools();
      store.appendMeta(providerName, provider.model, planMode);
      console.log(green(`  ● provider → ${providerName} (${provider.model})`));
    } catch (error) {
      console.error(red(`  ✖ ${(error as Error).message}`));
    }
  };

  const switchModel = async (model: string): Promise<void> => {
    if (!model) {
      const models = (await activeProvider.current.listModels?.()) || [];
      console.log(cyan(`  ${providerName} models:`));
      for (const entry of models.slice(0, 60)) console.log(`    ${entry}`);
      return;
    }
    try {
      provider = createProvider(providerName, model, settings);
      activeProvider.current = provider;
      rebuildTools();
      console.log(green(`  ● model → ${provider.model}`));
    } catch (error) {
      console.error(red(`  ✖ ${(error as Error).message}`));
    }
  };

  const handleCommand = async (line: string): Promise<void> => {
    const [command, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command) {
      case '/help':
        console.log(SLASH_HELP);
        return;
      case '/plan': {
        planMode = arg ? arg === 'on' || arg === 'true' : !planMode;
        rebuildTools();
        console.log(
          planMode
            ? yellow('  ◇ plan mode ON — research only; say "go" to implement')
            : green('  ◆ plan mode OFF — full toolset restored'),
        );
        return;
      }
      case '/model':
        await switchModel(arg);
        return;
      case '/provider':
        if (arg) switchProvider(arg);
        else console.log(`  provider: ${cyan(providerName)} ${dim(`(${activeProvider.current.model})`)}`);
        return;
      case '/tools': {
        console.log(cyan(`  ${tools.length} tools ${dim(`(plan mode: ${planMode ? 'on' : 'off'})`)}`));
        for (const tool of tools) console.log(`    ${dim(tool.permission.padEnd(5))} ${tool.name}`);
        return;
      }
      case '/stats':
      case '/status': {
        console.log(`  provider   ${cyan(providerName)} ${dim(activeProvider.current.model)}`);
        console.log(`  workdir    ${dim(workdir)}`);
        console.log(`  session    ${dim(store.file)}`);
        console.log(`  messages   ${dim(String(history.length))}`);
        console.log(`  tools      ${dim(String(tools.length))}`);
        console.log(`  plan mode  ${planMode ? 'on' : 'off'}   permissions: ${settings.permissions}`);
        console.log(
          `  effort     ${settings.reasoningEffort || 'unset'}   ` +
          `thinking: ${settings.alwaysThinking ? `on (${settings.maxThinkingTokens} tokens)` : 'off'}`,
        );
        for (const dir of grants) console.log(`  granted    ${dim(dir + ' (session)')}`);
        return;
      }
      case '/effort': {
        const valid = ['low', 'medium', 'high'];
        if (!arg) {
          console.log(
            `  reasoning effort: ${settings.reasoningEffort ? cyan(settings.reasoningEffort) : dim('unset')}` +
              dim('  (usage: /effort low|medium|high — applies to OpenAI-compatible providers on the next /provider or /model switch)'),
          );
          return;
        }
        if (!valid.includes(arg.toLowerCase())) {
          console.log(yellow(`  effort must be one of: ${valid.join(', ')}`));
          return;
        }
        settings.reasoningEffort = arg.toLowerCase();
        saveSettings(settings);
        console.log(green(`  ● reasoning effort → ${settings.reasoningEffort}${dim(' (rebuilt on next /provider or /model switch)')}`));
        return;
      }
      case '/permissions': {
        if (!arg) {
          console.log(`  permissions mode: ${cyan(settings.permissions)}`);
          console.log(`  session grants: ${grants.size ? [...grants].join(', ') : dim('(none this session)')}`);
          console.log(dim('  set with: /permissions default|ask|acceptEdits|bypass'));
          return;
        }
        const validModes = ['default', 'ask', 'acceptEdits', 'bypass'];
        if (!validModes.includes(arg)) {
          console.log(yellow(`  mode must be one of: ${validModes.join(', ')}`));
          return;
        }
        settings.permissions = arg;
        saveSettings(settings);
        console.log(green(`  ● permissions → ${arg} (persisted to settings.json)`));
        return;
      }
      case '/sessions': {
        const sessions = SessionStore.list(workdir);
        if (!sessions.length) {
          console.log(dim('  no sessions yet'));
          return;
        }
        for (const session of sessions.slice(0, 12)) {
          console.log(`  ${cyan(session.id)}  ${dim(session.updated.slice(0, 16))}  ${session.preview}`);
        }
        return;
      }
      case '/resume': {
        if (!arg) {
          console.log(yellow('  usage: /resume <session-id> (see /sessions)'));
          return;
        }
        const target = new SessionStore(workdir, arg);
        if (!fs.existsSync(target.file)) {
          console.log(red(`  ✖ no session '${arg}' for this project (see /sessions)`));
          return;
        }
        store = target;
        const rebuilt = target.replay();
        history.length = 0;
        buildSystem();
        history.push(...rebuilt);
        store.appendEvent({ type: 'summary', text: `resumed from ${arg}` });
        console.log(green(`  ● resumed ${arg} (${rebuilt.length} events)`));
        return;
      }
      case '/clear': {
        history.length = 0;
        buildSystem();
        console.log(green('  ● context cleared (same session file)'));
        return;
      }
      case '/compact': {
        store.compact();
        const rebuilt = store.replay();
        history.length = 0;
        buildSystem();
        history.push(...rebuilt);
        console.log(green('  ● context trimmed'));
        return;
      }
      case '/memory': {
        const memoryPath = path.join(activeWorkdir, 'ARDAN.md');
        if (!fs.existsSync(memoryPath)) {
          fs.writeFileSync(
            memoryPath,
            '# ARDAN.md — project memory\n\nEverything here is injected into the agent system prompt.\n\n- Build: ...\n- Test: ...\n- Conventions: ...\n',
          );
          console.log(green(`  ● created ${memoryPath}`));
        } else {
          console.log(`  memory file: ${cyan(memoryPath)} — edit it to steer every session`);
        }
        return;
      }
      case '/init': {
        const memoryPath = path.join(activeWorkdir, 'ARDAN.md');
        if (fs.existsSync(memoryPath)) {
          console.log(yellow(`  ⓘ ${memoryPath} already exists — leaving it untouched`));
          return;
        }
        const isGit = fs.existsSync(path.join(activeWorkdir, '.git'));
        const markers: Array<[string, string, string]> = [
          ['package.json', 'Node/TS', 'npm test'],
          ['pyproject.toml', 'Python', 'python -m pytest'],
          ['go.mod', 'Go', 'go test ./...'],
          ['Cargo.toml', 'Rust', 'cargo test'],
        ];
        let project = 'plain project';
        let test = '(run your test command here)';
        for (const [file, label, command] of markers) {
          if (fs.existsSync(path.join(activeWorkdir, file))) {
            project = label;
            test = command;
            break;
          }
        }
        const sampleCount = fs
          .readdirSync(activeWorkdir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .slice(0, 10)
          .map((entry) => `- ${entry.name}`)
          .join('\n');
        fs.writeFileSync(
          memoryPath,
          [
            `# ARDAN.md — project memory (scaffolded by /init)`,
            '',
            `- Project type: ${project}`,
            `- Git: ${isGit ? 'yes' : 'no'}`,
            `- Test command: ${'npm test'.includes(test) ? test : test}`,
            `- Build command: (fill me in)`,
            `- Conventions: (fill me in)`,
            '',
            '## Top-level files',
            sampleCount || '(empty directory)',
          ].join('\n'),
        );
        console.log(green(`  ● scaffolded ${memoryPath} — review and fill in the blanks`));
        return;
      }
      case '/agents': {
        if (!plugins.agents.length) {
          console.log(dim('  no custom subagents — add .ardan/agents/<name>.md (frontmatter: name, description, tools, model)'));
          return;
        }
        for (const agent of plugins.agents) {
          console.log(`  ${cyan(agent.name)} ${dim(agent.description)}${agent.model ? dim(` [${agent.model}]`) : ''}`);
        }
        return;
      }
      case '/skills': {
        if (!plugins.skills.length) {
          console.log(dim('  no skills — add .ardan/skills/<name>/SKILL.md (frontmatter: name, description)'));
          return;
        }
        for (const skill of plugins.skills) {
          console.log(`  ${cyan(skill.name)} ${dim(skill.description)}`);
        }
        return;
      }
      case '/plugins': {
        console.log(
          cyan(`  plugins:`),
          `${plugins.commands.length} commands, ${plugins.agents.length} subagents, ${plugins.skills.length} skills`,
        );
        if (plugins.commands.length) {
          console.log(`  ${bold('commands:')}`);
          for (const command of plugins.commands) console.log(`    /${command.name} ${dim(command.description)}`);
        }
        if (plugins.agents.length) {
          console.log(`  ${bold('subagents:')}`);
          for (const agent of plugins.agents) console.log(`    ${agent.name} ${dim(agent.description)}`);
        }
        if (plugins.skills.length) {
          console.log(`  ${bold('skills:')}`);
          for (const skill of plugins.skills) console.log(`    ${skill.name} ${dim(skill.description)}`);
        }
        return;
      }
      case '/hooks': {
        const configured = (settings.hooks || {}) as Record<string, Array<{ matcher?: string; command: string }>>;
        const events = Object.entries(configured).filter(([, entries]) => entries.length);
        if (!events.length) {
          console.log(dim('  no hooks configured — see ~/.ardan/settings.json "hooks"'));
          return;
        }
        for (const [event, entries] of events) {
          console.log(`  ${bold(event)}`);
          for (const entry of entries) {
            console.log(`    ${dim(entry.matcher ? `[${entry.matcher}] ` : '')}${entry.command}`);
          }
        }
        return;
      }
      case '/mcp': {
        if (!Object.keys(settings.mcpServers || {}).length && !mcpServers.length) {
          console.log(dim('  no MCP servers configured — add to ~/.ardan/settings.json "mcpServers"'));
          return;
        }
        for (const server of mcpServers) {
          const count = mcpToolDefs(server, []).length; // dynamic list lives in mcpTools
          console.log(`  ${green('●')} ${server.serverName}`);
          void count;
        }
        console.log(`  connected servers: ${mcpServers.length}, mcp tools: ${mcpTools.length}`);
        return;
      }
      case '/tasks': {
        const tasks = readTasks(activeWorkdir);
        if (!tasks.length) {
          console.log(dim('  no tasks yet'));
          return;
        }
        for (const task of tasks) {
          const box = task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[~]' : '[ ]';
          console.log(`  ${box} ${cyan(task.id)} ${task.content}`);
        }
        return;
      }
      case '/doctor': {
        console.log(`  node        ${process.version}`);
        console.log(`  workdir     ${dim(activeWorkdir)} (writable: ${((): string => { try { fs.accessSync(activeWorkdir, fs.constants.W_OK); return green('yes'); } catch { return red('no'); } })()}`);
        console.log(`  provider    ${cyan(providerName)} ${dim(activeProvider.current.model)}`);
        try {
          console.log(`  health      ${dim((await activeProvider.current.health?.()) || 'n/a')}`);
        } catch (error) {
          console.log(`  health      ${red((error as Error).message.slice(0, 100))}`);
        }
        console.log(`  settings    ${dim('~/.ardan/settings.json')}`);
        console.log(`  permissions ${settings.permissions === 'bypass' ? yellow(settings.permissions) : settings.permissions}`);
        console.log(`  session     ${dim(store.file)}`);
        console.log(`  plugins     ${dim(`${plugins.commands.length} commands / ${plugins.agents.length} subagents / ${plugins.skills.length} skills`)}`);
        console.log(`  hooks       ${dim(String(Object.values(settings.hooks || {}).flat().length))}`);
        console.log(`  mcp         ${dim(`${mcpServers.length} connected`)}`);
        return;
      }
      case '/schedule': {
        const tasks = readSchedule(activeWorkdir);
        if (!tasks.length) {
          console.log(dim('  no scheduled prompts — the model can CronCreate them, or CronList shows one-shot jobs'));
          return;
        }
        for (const task of tasks) {
          console.log(`  ${cyan(task.id)}  ${task.kind === 'every' ? `every ${task.minutes}m` : task.kind === 'daily' ? `daily ${task.time}` : `at ${task.at}`}${task.recurring ? '' : dim(' (once)')}  ${dim(task.prompt.slice(0, 60))}`);
        }
        return;
      }
      case '/output-style': {
        if (!arg || arg === 'list') {
          console.log('  output styles:');
          console.log(`    cyan default ${dim('(clear any custom style)')}`);
          for (const style of outputStyles) {
            const mark = style.name === activeStyleName ? green('← active') : '';
            console.log(`    ${style.name}  ${dim(style.description)} ${mark}`);
          }
          const active = activeStyleName && outputStyles.some((s) => s.name === activeStyleName);
          if (activeStyleName && !active) console.log(dim(`    (current '${activeStyleName}' not found) `));
          return;
        }
        if (arg === 'default' || arg === 'none' || arg === 'off') {
          activeStyleName = undefined;
          buildSystem();
          console.log(green('  ● output style cleared'));
          return;
        }
        const style = outputStyles.find((entry) => entry.name === arg.toLowerCase());
        if (!style) {
          console.log(red(`  ✖ no output style '${arg}'. /output-style list shows what is installed`));
          return;
        }
        activeStyleName = style.name;
        buildSystem();
        console.log(green(`  ● output style → ${style.name}`));
        return;
      }
      case '/context': {
        let chars = 0;
        const byRole: Record<string, number> = {};
        for (const message of history) {
          byRole[message.role] = (byRole[message.role] || 0) + 1;
          chars += message.content.length;
        }
        console.log(`  context: ${dim(history.length)} messages, ~${dim(String(Math.round(chars / 4)))} tokens (${chars} chars)`);
        for (const [role, count] of Object.entries(byRole)) {
          console.log(`    ${role.padEnd(9)} ${dim(String(count))}`);
        }
        console.log(`  tools: ${dim(String(tools.length))} in catalog${planMode ? dim(' (plan mode limited set)') : ''}`);
        return;
      }
      case '/cost': {
        let chars = 0;
        let assistantTurns = 0;
        let toolRuns = 0;
        for (const message of history) {
          chars += message.content.length;
          if (message.role === 'assistant') assistantTurns++;
          if (message.role === 'tool') toolRuns++;
        }
        const tokens = Math.round(chars / 4);
        const localFree = providerName === 'ollama';
        console.log(`  turns: ${assistantTurns}   tool runs: ${toolRuns}   ~tokens in context: ${tokens}`);
        if (localFree) {
          console.log(`  estimated cost: ${green('$0 (local Ollama model)')}`);
        } else {
          console.log(`  estimated cost: see your provider dashboard (token estimate ~${tokens} in context; actual billed tokens vary)`);
        }
        return;
      }
      case '/diff': {
        const controller = new AbortController();
        const outcome = await bashTool().run(
          { command: 'git diff --stat HEAD && git status --short' },
          { workdir: activeWorkdir, sessionId: store.id, signal: controller.signal, state: sharedState } satisfies ToolContext,
        );
        const history2 = sharedState.get('fileHistory') as Map<string, string | null> | undefined;
        const touched = history2 ? [...history2.keys()].map((file) => path.relative(activeWorkdir, file) || file) : [];
        if (outcome.ok && outcome.output.trim()) {
          console.log(outcome.output.trim().split('\n').slice(0, 40).map((line) => `  ${line}`).join('\n'));
        } else {
          console.log(dim('  no git diff available (not a repo or no changes)'));
        }
        if (touched.length) {
          console.log(cyan('  files touched this session (restore with /rewind files):'));
          for (const file of touched.slice(0, 20)) console.log(`    ${file}`);
        }
        return;
      }
      case '/copy': {
        if (!lastAssistantText) {
          console.log(dim('  nothing to copy yet'));
          return;
        }
        const copyCommands: Record<string, string> = {
          win32: 'clip',
          darwin: 'pbcopy',
          linux: 'xclip -selection clipboard',
        };
        try {
          execSync(copyCommands[process.platform] || 'clip', {
            input: lastAssistantText,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          const tmpFile = path.join(os.tmpdir(), 'ardan-response.md');
          fs.writeFileSync(tmpFile, lastAssistantText, 'utf8');
          console.log(green(`  ● copied to clipboard (also saved: ${tmpFile})`));
        } catch (error) {
          console.log(red(`  ✖ clipboard failed: ${(error as Error).message.slice(0, 120)}`));
        }
        return;
      }
      case '/export': {
        const target = arg
          ? path.resolve(activeWorkdir, arg)
          : path.join(activeWorkdir, 'ardan-output', `session-${store.id}.md`);
        try {
          fs.accessSync(path.dirname(target), fs.constants.W_OK);
        } catch {
          /* will error on write otherwise */
        }
        console.log(green(`  ● exported ${store.exportMarkdown(target)}`));
        return;
      }
      case '/rename': {
        const title = arg || undefined;
        if (!title) {
          const firstUser = history.find((message) => message.role === 'user')?.content || '';
          const generated = firstUser.replace(/\s+/g, ' ').slice(0, 40).trim();
          if (!generated) {
            console.log(dim('  /rename <title> sets a name for this session'));
            return;
          }
          store.setTitle(generated);
          console.log(green(`  ● session renamed: "${generated}"`));
          return;
        }
        store.setTitle(title);
        console.log(green(`  ● session renamed: "${title}"`));
        return;
      }
      case '/goal': {
        if (!arg || arg === 'status') {
          console.log(sessionGoal ? `  goal: ${cyan(sessionGoal)}` : dim('  no active goal — /goal <text> sets one'));
          return;
        }
        if (arg === 'stop' || arg === 'off') {
          sessionGoal = undefined;
          store.appendMetaEvent('goal', { action: 'stop' });
          console.log(green('  ● goal cleared'));
          return;
        }
        sessionGoal = arg;
        store.appendMetaEvent('goal', { text: arg });
        console.log(green(`  ● goal set: ${arg}`));
        return;
      }
      case '/rewind': {
        const parts = arg.split(/\s+/).filter(Boolean);
        const count = Number(parts[0]);
        const userTurnCount = history.filter((message) => message.role === 'user').length;
        if (parts.length === 0 || parts[0].startsWith('/') || !Number.isFinite(count)) {
          console.log(dim(`  usage: /rewind <n> [files]  — keeps user turns 1..n, drops the rest (you have ${userTurnCount}); 'files' restores file state as of turn n`));
          return;
        }
        if (count < 0 || count > userTurnCount) {
          console.log(red(`  ✖ n must be between 0 and ${userTurnCount} (user turns in this session)`));
          return;
        }
        const removed = store.rewind(count);
        if (parts.includes('files')) {
          const rewindCtx = { workdir: activeWorkdir, sessionId: store.id, signal: new AbortController().signal, state: sharedState };
          // Files touched after turn `count` go back to their state as of the
          // end of turn `count` (per-turn checkpoints); count 0 = session start.
          const restored =
            count === 0
              ? restoreFileHistory(rewindCtx)
              : restoreFileHistoryAt(rewindCtx, count);
          history.length = 0;
          history.push(...store.replay());
          buildSystem();
          console.log(green(`  ● rewound to after user turn ${count}, ${removed} events removed`));
          if (restored.length) {
            console.log(`  file state restored (as of turn ${count}): ${restored.join(', ')}`);
          } else if (count > 0) {
            console.log(dim(`  no file changes in turns > ${count} to revert`));
          }
          return;
        }
        history.length = 0;
        history.push(...store.replay());
        buildSystem();
        console.log(green(`  ● rewound to after user turn ${count}, ${removed} events removed`));
        return;
      }
      case '/brief': {
        await runTurn('Brief catch-me-up: summarize what we have done in this session so far in at most 8 bullet points (from the conversation so far), then note what is left. No tools needed.');
        return;
      }
      case '/review': {
        await runTurn('Do a code review pass of the current working tree: run git diff (Bash), read the changed files else review the project, then give: findings by severity (blocker/warning/nit) with file:line references, and a final verdict. Do NOT modify files.');
        return;
      }
      case '/security-review': {
        await runTurn('Security review pass: inspect handling of user input, secrets/logging, injections (shell/SQL/path traversal), unsafe deserialization and dependency risks in the current working tree (use Read/Grep/repo tools; git diff for recent changes). Report findings by severity with concrete fixes. Do NOT modify files.');
        return;
      }
      case '/search': {
        if (!arg) {
          console.log(dim('  usage: /search <query>'));
          return;
        }
        await runTurn(`Search the web for: ${arg}\nReport the 3 most relevant results with a one-line takeaway each and include links.`);
        return;
      }
      case '/config': {
        const editor = process.platform === 'win32' ? 'notepad.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'darwin' ? [settingsPath()] : [settingsPath()];
        try {
          spawn(editor, args, { detached: true, stdio: 'ignore' }).unref?.();
        } catch {
          /* launcher missing - print path instead */
        }
        console.log(cyan(`  opening ${settingsPath()} — changes apply on next start`));
        return;
      }
      case '/exit':
      case '/quit':
        exitRepl();
        return;
      default: {
        // custom commands, then user-invocable skills
        const custom = plugins.commands.find((entry) => entry.name === command.slice(1));
        if (custom) {
          await runTurn(substituteArguments(custom.prompt, arg));
          return;
        }
        const skill = plugins.skills.find(
          (entry) => entry.name === command.slice(1) && entry.userInvocable,
        );
        if (skill) {
          const raw = fs.readFileSync(skill.file, 'utf8');
          const body = parseFrontmatter(raw).body;
          await runTurn(`[skill ${skill.name}]\n${substituteArguments(body, arg)}`);
          return;
        }
        console.log(red(`  ✖ unknown command '${command}' — try /help`));
        return;
      }
    }
  };

  /* --------------------------------------------------------------- loop */
  let lastCtrlC = 0;
  const askLine = (promptText: string): Promise<string | null> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: (line: string, callback: (err: null, hits: [string[], string]) => void) => {
          if (line.startsWith('@')) {
            const fragment = line.slice(1).replace(/\\/g, '/');
            const dirPart = fragment.includes('/') ? fragment.slice(0, fragment.lastIndexOf('/')) : '.';
            const base = fragment.includes('/') ? fragment.slice(fragment.lastIndexOf('/') + 1) : fragment;
            try {
              const absDir = path.resolve(workdir, dirPart);
              const hits = fs
                .readdirSync(absDir, { withFileTypes: true })
                .filter((entry) => entry.name.startsWith(base))
                .slice(0, 12)
                .map((entry) =>
                  `@${dirPart === '.' ? '' : `${dirPart}/`}${entry.name}${entry.isDirectory() ? '/' : ''}`,
                );
              callback(null, [hits, line]);
            } catch {
              callback(null, [[], line]);
            }
          } else {
            const hits = SLASH_COMMANDS.filter((command) => command.startsWith(line));
            callback(null, [hits, line]);
          }
        },
        historySize: 200,
      });
      rl.on('SIGINT', () => {
        const now = Date.now();
        if (now - lastCtrlC < 1500) {
          rl.close();
          finish('__exit__');
          return;
        }
        lastCtrlC = now;
        process.stdout.write('\n(press Ctrl+C again to exit)\n');
        rl.prompt();
      });
      rl.on('close', () => finish(null));
      rl.question(isTTY ? color('96', promptText) : promptText, (answer) => {
        rl.close();
        finish(answer);
      });
    });

  if (options.oneShot) {
    const prefix = expandMentions(options.oneShot);
    await runTurn(options.oneShot, prefix);
    exitRepl();
  }

  if (!process.stdin.isTTY) {
    console.log(
      dim('stdin is not interactive — pass a prompt:   ardan "fix the failing tests"   (or see --help)'),
    );
    exitRepl(0);
  }

  while (true) {
    const line = await askLine(`${cyan('❯')} `);
    if (line === null || line === '__exit__') exitRepl();
    const trimmed = (line || '').trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      continue;
    }
    if (trimmed.startsWith('!')) {
      await runShell(trimmed.slice(1).trim());
      continue;
    }
    await runTurn(trimmed, expandMentions(trimmed));
  }
}

function readMemory(workdir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workdir, 'ARDAN.md'), 'utf8');
  } catch {
    return undefined;
  }
}
