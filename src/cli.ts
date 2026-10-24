// Ardan CLI entry: argument parsing, subcommands, REPL bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import { printBanner, dim, cyan, green, red, magenta, bold } from './render.ts';
import { startRepl } from './repl.ts';
import {
  autoPickProvider,
  createProvider,
  defaultModelFor,
  findApiKey,
  getApiBase,
  loadSettings,
  saveSettings,
  ollamaReachable,
} from './config.ts';
import { PROVIDER_META } from './providers/base.ts';

export const VERSION = '0.6.0';

const USAGE = `${bold('Ardan')} ${dim(VERSION)} — open coding agent (openclaude-style architecture)

${bold('Usage')}
  ardan                       interactive REPL
  ardan "<task>"              one-shot agent run (scripts, CI)
  ardan --continue            resume the latest session for this folder
  ardan --resume <id>         resume a specific session

${bold('Options')}
  -p, --provider <name>       ollama | anthropic | openai | gemini | groq | mistral | openrouter | deepseek
  -m, --model <name>          model id (defaults per provider; see: ardan models)
  -y, --yes                   auto-accept tool calls (for scripts/CI)
      --plan                  start in plan mode (read-only tools)
      --cwd <dir>             working directory (default: current)
      --resume <id>           resume session id
  -c, --continue              resume latest session
  -h, --help                  this help
  -v, --version               version

${bold('Subcommands')}
  ardan providers             available providers + key status
  ardan models [provider]     list models from the API
  ardan keys list             which API keys are configured
  ardan keys set <provider> <key>
  ardan keys test [provider]  verify reachability/keys

${bold('Env')}   ARDAN_PROVIDER, ARDAN_MODEL, ARDAN_PERMISSIONS=ask|acceptEdits|bypass,
  ARDAN_REASONING_EFFORT=low|medium|high, ARDAN_DISABLE_CRON, ARDAN_DISABLE_TASK_NOTIFICATIONS
  keys: ANTHROPIC_API_KEY GEMINI_API_KEY OPENAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY DEEPSEEK_API_KEY
  settings: ~/.ardan/settings.json (permissions, maxTokens, alwaysThinking, maxThinkingTokens,
    lspServers for the Diagnostics tool, mcpServers, custom providers)`;

/* ---------------------------------------------------------- arg parsing */
const HELP = process.argv.includes('-h') || process.argv.includes('--help');
const VERSION_FLAG = process.argv.includes('-v') || process.argv.includes('--version');

if (VERSION_FLAG) {
  console.log(VERSION);
  process.exit(0);
}
if (HELP) {
  console.log(USAGE);
  process.exit(0);
}

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string | boolean> = {};
const BOOL_FLAGS = new Set(['yes', 'plan', 'continue']);
const SHORTS: Record<string, string> = {
  p: 'provider', m: 'model', y: 'yes', c: 'continue',
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--') continue; // positional separator
  if (arg.startsWith('--')) {
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
    } else {
      const value = argv[++i];
      flags[name] = value === undefined ? true : value;
    }
  } else if (arg.startsWith('-') && arg.length === 2) {
    const name = SHORTS[arg.slice(1)];
    if (!name) continue;
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
    } else {
      const value = argv[++i];
      flags[name] = value === undefined ? true : value;
    }
  } else {
    positional.push(arg);
  }
}

/* --------------------------------------------------------- subcommands */
const subcommand = positional[0];
const settings = loadSettings();

function saveKey(provider: string, key: string): void {
  settings.providers = settings.providers || {};
  settings.providers[provider] = { ...(settings.providers[provider] || {}), apiKey: key };
  saveSettings(settings);
}

if (subcommand === 'keys') {
  const action = positional[1] || 'list';
  if (action === 'set') {
    const provider = positional[2];
    const key = positional[3];
    if (!provider || !key) {
      console.log('usage: ardan keys set <provider> <key>');
      process.exit(1);
    }
    saveKey(provider, key);
    console.log(green(`✔ ${provider} key saved to ~/.ardan/settings.json`));
    process.exit(0);
  }
  if (action === 'test') {
    const names = positional[2] ? [positional[2]] : Object.keys(PROVIDER_META);
    for (const name of names) {
      try {
        const target = createProvider(name, undefined, settings);
        const health = (await target.health?.()) ?? 'no health check available';
        const ok = !/^(unreachable|no API|HTTP)/.test(health);
        console.log(`  ${cyan(name.padEnd(11))} ${ok ? green(health) : dim(health)}`);
      } catch (error) {
        console.log(`  ${cyan(name.padEnd(11))} ${dim((error as Error).message)}`);
      }
    }
    process.exit(0);
  }
  // list (default)
  for (const provider of Object.keys(PROVIDER_META)) {
    let marker: string;
    if (provider === 'ollama') {
      marker = ollamaReachable(getApiBase('ollama', settings) as string)
        ? green('✔ running locally (no key needed)')
        : dim('not running — start with: ollama serve');
    } else {
      const found = findApiKey(provider, settings);
      marker = found ? green('✔ key configured') : dim('no key (env or: ardan keys set ' + provider + ')');
    }
    console.log(`  ${cyan(provider.padEnd(11))} ${marker}`);
  }
  process.exit(0);
}

if (subcommand === 'mcp') {
  const action = positional[1];
  const serverMap = { ...(settings.mcpServers || {}) } as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  if (action === 'add') {
    const name = positional[2];
    const rest = positional.slice(3);
    if (!name || !rest.length) {
      console.log('usage: ardan mcp add <name> <command> [args...]   (or list / remove)');
      process.exit(1);
    }
    serverMap[name] = { command: rest[0], args: rest.slice(1) };
    settings.mcpServers = serverMap;
    saveSettings(settings);
    console.log(
      green(`✔ MCP server '${name}' saved — restart ardan to connect:\n  ${rest.join(' ')}`),
    );
    process.exit(0);
  }
  if (action === 'remove') {
    const name = positional[2];
    if (!name || !serverMap[name]) {
      console.log(name ? red(`no MCP server named '${name}'`) : 'usage: ardan mcp remove <name>');
      process.exit(1);
    }
    delete serverMap[name];
    settings.mcpServers = serverMap;
    saveSettings(settings);
    console.log(green(`✔ removed '${name}'`));
    process.exit(0);
  }
  console.log(bold('MCP servers'));
  if (!Object.keys(serverMap).length) {
    console.log(dim('  none configured — add one: ardan mcp add github -- npx -y @modelcontextprotocol/server-github'));
  }
  for (const [name, config] of Object.entries(serverMap)) {
    console.log(`  ${cyan(name)}  ${dim([config.command, ...(config.args || [])].join(' '))}`);
  }
  process.exit(0);
}

if (subcommand === 'providers') {
  const chosen = settings.defaultProvider || autoPickProvider(settings);
  for (const [provider, model] of Object.entries(PROVIDER_META)) {
    const available =
      provider === 'ollama'
        ? ollamaReachable(getApiBase('ollama', settings) as string)
        : Boolean(findApiKey(provider, settings));
    const mark = available ? green('●') : dim('○');
    const current = provider === chosen ? magenta('  ← default') : '';
    console.log(`  ${mark} ${cyan(provider.padEnd(11))} ${model}${current}`);
  }
  console.log(dim(`  default picked from ~/.ardan/settings.json → ${chosen}`));
  process.exit(0);
}

if (subcommand === 'models') {
  const name = positional[1] || settings.defaultProvider || autoPickProvider(settings);
  try {
    const target = createProvider(name, undefined, settings);
    const models = (await target.listModels?.()) || [];
    if (!models.length) {
      console.log(dim(`no models listed for ${name} (or the provider does not expose a list API)`));
      process.exit(0);
    }
    console.log(cyan(`${name} (${models.length}):`));
    for (const model of models) console.log(`  ${model}`);
  } catch (error) {
    console.error(red(`✖ ${(error as Error).message}`));
    process.exit(1);
  }
  process.exit(0);
}

/* ----------------------------------------------------------------- main */
const workdir = path.resolve(typeof flags.cwd === 'string' ? (flags.cwd as string) : process.cwd());
if (!fs.existsSync(workdir)) {
  console.error(red(`✖ --cwd '${workdir}' does not exist`));
  process.exit(1);
}
process.chdir(workdir);

const chosenProvider =
  (typeof flags.provider === 'string' ? flags.provider : undefined) ||
  process.env.ARDAN_PROVIDER ||
  settings.defaultProvider ||
  autoPickProvider(settings);
const chosenModel =
  (typeof flags.model === 'string' ? flags.model : undefined) ||
  process.env.ARDAN_MODEL ||
  settings.providers?.[chosenProvider]?.model ||
  defaultModelFor(chosenProvider);

printBanner(chosenProvider, chosenModel);

const prompt = positional.length ? positional.join(' ') : undefined;

await startRepl({
  workdir,
  providerName: chosenProvider,
  modelOverride: chosenModel,
  resumeId: typeof flags.resume === 'string' ? (flags.resume as string) : undefined,
  continueFlag: Boolean(flags.continue),
  autoYes: Boolean(flags.yes) || process.env.ARDAN_AUTO_ACCEPT === '1',
  planMode: Boolean(flags.plan),
  oneShot: prompt,
});
