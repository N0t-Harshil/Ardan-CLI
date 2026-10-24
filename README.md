# Ardan

    █████╗ ██████╗ ██████╗  █████╗ ███╗   ██╗
   ██╔══██╗██╔══██╗██╔══██╗██╔══██╗████╗  ██║
   ███████║██████╔╝██║  ██║███████║██╔██╗ ██║
   ██╔══██║██╔══██╗██║  ██║██╔══██║██║╚██╗██║
   ██║  ██║██████╔╝██████╔╝██║  ██║██║ ╚████║
   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝

Ardan is a fast, lightweight terminal coding agent in the style of
openclaude / Claude Code: you type a task, Ardan streams the answer,
runs tools (read, write, edit, bash, search, web), observes the
results and keeps going until the job is done.

- **TypeScript, zero runtime dependencies** - npm package, instant
  startup, no build step (Node 24 strips types natively).
- **Any model** - Ollama (local), Anthropic, OpenAI, Gemini, Groq,
  Mistral, OpenRouter, DeepSeek, or any OpenAI-compatible endpoint.
- **Text-JSON tool-call fallback** - works with small local models that
  do not support native tool calling (e.g. qwen2.5-coder via Ollama).

## Install

Requires Node.js >= 24.

    npm install -g .

then run:

    ardan --version

or without installing:

    node bin/ardan.js

## Quickstart

Interactive session:

    ardan

One-shot task (script/CI friendly):

    ardan --yes "Add a README badge and commit it"
    ardan --yes --cwd some-project "Make the failing tests pass"

Resume work:

    ardan --continue            # latest session for this folder
    ardan --resume <session-id>

Attach files inline with @ mentions, run shell directly with !:

    @src/index.ts why does this file crash on startup?
    !git status

## Providers

First available provider wins; override with ARDAN_PROVIDER /
--provider. Default model per provider (override --model / ARDAN_MODEL):

| provider   | default model            | key needed |
|------------|--------------------------|------------|
| ollama     | qwen2.5-coder:14b        | no (local) |
| anthropic  | claude-sonnet-4-5        | ANTHROPIC_API_KEY |
| openai     | gpt-4.1                  | OPENAI_API_KEY |
| gemini     | gemini-2.5-flash         | GEMINI_API_KEY |
| groq       | llama-3.3-70b-versatile  | GROQ_API_KEY |
| mistral    | codestral-latest         | MISTRAL_API_KEY |
| openrouter | deepseek/deepseek-chat   | OPENROUTER_API_KEY |
| deepseek   | deepseek-chat            | DEEPSEEK_API_KEY |

Subcommands:

    ardan providers             # what is available + default pick
    ardan models [provider]     # list models from the API
    ardan keys list             # key status
    ardan keys set groq gsk_...
    ardan keys test [provider]

Keys can come from env vars or be persisted to ~/.ardan/settings.json
with `ardan keys set`.

Custom OpenAI-compatible endpoints belong in settings.json:

    {
      "providers": {
        "lmstudio": {
          "type": "openai",
          "apiBase": "http://localhost:1234/v1",
          "apiKey": "lm-studio",
          "model": "qwen2.5-coder-14b-instruct"
        }
      },
      "defaultProvider": "lmstudio"
    }

## Tools

Ardan ships the full openclaude-class toolset (36 built-ins):

    Read  Write  Edit  ListDir  Glob  Grep  Bash  PowerShell
    TodoWrite  WebFetch  WebSearch  Task (sub-agent, custom agents)
    TaskOutput  TaskStop  Monitor (background task control)
    AskUserQuestion  EnterPlanMode / ExitPlanMode
    RepoMap  NodeRepl (persistent JS sandbox)  NotebookEdit (.ipynb)
    CtxInspect  ToolSearch  DiscoverSkills  Diagnostics (LSP)
    TaskCreate  TaskGet  TaskUpdate  TaskList
    CronCreate  CronList  CronDelete (scheduled prompts)
    EnterWorktree / ExitWorktree  Skill  Sleep
    ListMcpResources  ReadMcpResource

Plan mode swaps the catalog down to a research-only set.

### Background tasks

Long commands don't have to block the loop:

    Bash(run_in_background: true)   ->  task id "b1"

The agent polls TaskOutput(task_id, block=true) for output and exit
status, kills with TaskStop, and the REPL injects a task-notification
message into the conversation when something finishes while idle.
PowerShell run_in_background works the same way.

Foreground commands run *unattended* for at most ~15 seconds: if a
plain Bash/PowerShell call is still running after that budget, it is
automatically moved into the background registry and the tool call
returns a receipt with a task id (openclaude-style auto-backgrounding).
The Monitor tool goes further: it registers the task immediately and
streams new stdout into the conversation while the command runs
(default cap 30 min) — good for log tailing, dev servers and watchers.

### LSP diagnostics

Configure language servers once per project/plugin dir in
settings.json, then use the Diagnostics tool to check files:

    "lspServers": {
      "typescript-language-server": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".mjs"]
      }
    }

The tool performs the full stdio LSP handshake per call
(initialize/initialized/didOpen) and collects publishDiagnostics for
that file with a 4s default wait (timeout arg overridable). Servers
are killed after the call — no daemons, no ambient state.

### Scheduled prompts

    CronCreate(prompt: "check CI status", schedule: "every:15m")
    CronCreate(prompt: "starting tomorrow, summarize today's work", schedule: "daily:17:30")
    CronCreate(prompt: "run the release checklist", schedule: "at:2026-10-25T09:00Z")

Stored per-project in .ardan/scheduled_tasks.json (max 50); recurring
jobs stamp their lastFired, one-shots self-delete. While the REPL is
open, due prompts fire automatically as a normal agent turn. `/schedule`
lists them; manage with CronList/CronDelete.

## MCP

MCP servers (stdio) are opt-in - add from the CLI:

    ardan mcp add github -- npx -y @modelcontextprotocol/server-github
    ardan mcp list
    ardan mcp remove github

or via settings.json:

    "mcpServers": {
      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
    }

Their tools appear as mcp__<server>__<tool>; /mcp shows connection status,
ListMcpResources / ReadMcpResource expose server resources, and with many
MCP tools installed the agent can locate them by keyword via ToolSearch.

## Plugins: commands, subagents, skills, output styles

Drop markdown files in the project (+ ~/.ardan for user-wide) - they are
picked up automatically and shown by /plugins:

- `.ardan/commands/*.md` -> custom slash commands. The file body is the
  prompt; `$ARGUMENTS` / `$1..` are filled from what you type after the
  command; lines starting with `!` are executed inline at load time and
  replaced by their shell output. Frontmatter `description` is optional.

      /audit src/lib

- `.ardan/agents/<name>.md` -> subagents callable through the Task tool's
  `subagent` argument (or /agents to list). Frontmatter:

      ---
      name: auditor
      description: Read-only project auditor
      tools: Read, Grep, RepoMap
      model: qwen2.5-coder:7b      # optional
      maxTurns: 6                  # optional, default 8
      permissionMode: default      # or bypassPermissions
      ---

- `.ardan/skills/<name>/SKILL.md` -> skills. The system prompt lists name +
  description; the model loads the playbook with the Skill tool on demand
  (DiscoverSkills lists them), and you can invoke any skill directly as
  /<name>. Frontmatter keys: `name`, `description`, `allowed-tools`,
  `user-invocable: false|true`.

- `.ardan/output-styles/<name>.md` -> output styles: frontmatter
  `name`/`description`/`keep-coding-instructions: false|true`; the body is
  injected as a system-prompt style directive. `/output-style` lists,
  `/output-style <name>` sets, `/output-style default` clears.

## Hooks

Configure shell hooks per event in ~/.ardan/settings.json; each entry
gets a JSON payload (event, tool, args, session, cwd) on stdin and env
ARDAN_HOOK_EVENT / ARDAN_HOOK_TOOL:

    "hooks": {
      "PreToolUse":  [ { "matcher": "Bash|Write", "command": "guard.cmd" } ],
      "PostToolUse": [ { "command": "log.cmd" } ],
      "UserPromptSubmit": [ { "command": "policy.cmd" } ],
      "SessionStart": [...], "SessionEnd": [...]
    }

`matcher` is a pipe-list regex of tool names. Non-zero PreToolUse exit
(or stdout JSON {"decision":"block"}) blocks the tool; that output
becomes the model's denial reason.

## Slash commands

Built-ins:

    /help  /plan  /model <name>  /provider <name>  /tools  /status /stats /context
    /effort <low|medium|high>  /permissions [mode]
    /cost  /diff  /copy  /export  /rename <title>  /rewind <n> [files]
    /goal <text|stop|status>  /brief  /review  /security-review
    /search <query>  /config  /schedule  /output-style [name]
    /sessions  /resume <id>  /clear  /compact
    /tasks  /memory  /init  /agents  /skills  /plugins  /hooks  /mcp
    /doctor  /exit

- /plan toggles plan mode; the agent can also enter/leave it itself with
  the EnterPlanMode / ExitPlanMode tools. Leaving plan mode via
  ExitPlanMode asks for your approval first (y/n) before switching.
- /rewind keeps user turns 1..n and drops the rest; add `files` to also
  roll back file changes: Write/Edit capture a per-turn checkpoint, and
  `/rewind n files` restores every file touched in turns > n to its
  state as of the end of turn n (`/rewind 0 files` = session start).
- /effort sets the OpenAI-compatible reasoning_effort (persisted);
  /permissions views or persists the permission mode; /status is an
  alias of /stats that also shows effort, thinking and session grants.
- /diff shows git changes plus files touched this session; /copy puts the
  last reply on the clipboard; /export writes the transcript as markdown;
  /rename titles the session (shown by /sessions).
- /init scaffolds ARDAN.md; /review and /security-review run guided
  read-only review passes; /brief summarizes the session.
- Custom commands and skills from .ardan/ are callable directly:
  `/audit src/lib`, `/greeting`.

## Permissions

Tool requests that write or execute things ask for confirmation:

    ? Bash(git push --force)
      allow? [y] once  [a] this session  [n] no

Modes (ARDAN_PERMISSIONS env, settings.json "permissions", or the
/permissions command - which persists it):

- ask - confirm everything risky (default)
- acceptEdits - file edits run without prompting
- bypass - never prompt (also: --yes flag, for scripts/CI)

## Sessions

Every project gets its own transcript dir under
~/.ardan/projects/<folder>. Sessions are saved as JSONL, resumeable
with --continue / /resume, and compactable with /compact.

## Project memory

Create ARDAN.md in the project root (or run /memory). Its content is
injected into the system prompt of every session - the right place for
build commands and conventions.

## Configuration

    ~/.ardan/settings.json

    {
      "defaultProvider": "ollama",
      "permissions": "ask",
      "maxTurns": 30,
      "reasoningEffort": "high",
      "maxTokens": 8192,
      "alwaysThinking": false,
      "maxThinkingTokens": 4096,
      "lspServers": {},
      "mcpServers": {},
      "hooks": {},
      "providers": {}
    }

Env: ARDAN_PROVIDER, ARDAN_MODEL, ARDAN_PERMISSIONS, ARDAN_MAX_TURNS,
ARDAN_REASONING_EFFORT, ARDAN_ALWAYS_THINKING, ARDAN_DISABLE_CRON,
ARDAN_DISABLE_TASK_NOTIFICATIONS, ARDAN_OLLAMA_BASE_URL, NO_COLOR.
`reasoningEffort` is sent as the OpenAI-compatible `reasoning_effort`
field for providers that support it (o-series, deepseek-r1, ...).
`maxTokens` is honored by every provider adapter. With
`alwaysThinking: true`, the Anthropic adapter requests extended
thinking with `thinking.budget_tokens = maxThinkingTokens` (thinking
deltas stream like text) and Gemini gets
`generationConfig.thinkingConfig.thinkingBudget`.

## Architecture

    bin/ardan.js              launcher (Node >= 24 check)
    src/cli.ts                args, subcommands (keys/providers/models/mcp), bootstrap
    src/repl.ts               interactive loop, slash commands, @file, !shell, hooks wiring
    src/agent.ts              the agent loop (stream -> tools -> repeat)
    src/types.ts              shared types + tool contract
    src/config.ts             env-first settings, provider wiring
    src/render.ts             ANSI renderer + tool-JSON suppression
    src/session.ts            JSONL transcripts, resume/rewind/export, titles, goals
    src/plugins/
      loader.ts               frontmatter + commands/agents/skills/output-styles discovery
      hooks.ts                hook engine (PreToolUse/PostToolUse/...)
      scheduler.ts            CronCreate/CronList/CronDelete + due-task firing
    src/providers/
      openai.ts               OpenAI-compatible SSE (openai/groq/mistral/openrouter/deepseek)
      ollama.ts               native /api/chat (local, tools, tok/s)
      anthropic.ts            Messages SSE
      gemini.ts               generateContent SSE
      index.ts                failover chain (switches only before first token)
    src/tools/
      index.ts                registry + plan-mode filter
      bash.ts                 Bash + PowerShell + managed spawn (auto-background)
      files.ts globgrep.ts misc.ts mcp.ts
      background.ts           TaskOutput / TaskStop / Monitor / notifications
      lsp.ts                  Diagnostics tool (stdio LSP client)
      searchtools.ts          ToolSearch + DiscoverSkills
      interactive.ts          AskUserQuestion, Enter/ExitPlanMode
      inspect.ts              RepoMap, NodeRepl, NotebookEdit, CtxInspect, MCP resources
      tasks.ts                TaskCreate/Get/Update/List
      worktree.ts             git worktree isolation
      skillstool.ts           Skill playbook loader
    src/utils/tooljson.ts     fallback parser for text-emitted tool calls
    tests/                    node:test suite (npm test - 74 tests)

## Troubleshooting

- "Ollama unreachable" - start it: ollama serve
- "model not pulled" - run: ollama pull qwen2.5-coder:14b
- First answers on a local 14B model can take a while while the model
  loads (cold prefill with the full tool catalog); later turns are fast
- Windows console glyphs - use Windows Terminal (UTF-8), or NO_COLOR=1
- Node < 24 - upgrade: winget install OpenJS.NodeJS

## Not implemented (deliberately)

Cloud/IDE-coupled openclaude features that a zero-dependency terminal
CLI cannot honor are intentionally absent: browser control (WebBrowser),
IDE/mobile/desktop connectors, remote sessions & teams, LSP hover/"go
to definition" automation (local publishDiagnostics IS implemented via
the Diagnostics tool), statusline/theming customization, OAuth MCP,
cloud reviews (/ultrareview), vim keybindings and UI themes.
Everything that runs locally is in the tables above.

## Legacy Python implementation

The previous Python implementation (planner/reviewer pipeline) is kept
as reference under the ardan/ python package (pip install -e .). The
TypeScript CLI in this repository root is the current product; the
Python version will not receive further feature work.
