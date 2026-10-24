// Config layer: env-first (openclaude-style), then ~/.ardan/settings.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OllamaProvider } from './providers/ollama.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { GeminiProvider } from './providers/gemini.ts';
import { OpenAICompatProvider } from './providers/openai.ts';
import {
  DEFAULTS,
  PROVIDER_META,
  resolveProviderName,
  type Provider,
  type Settings,
} from './providers/base.ts';

export function configDir(): string {
  return process.env.ARDAN_CONFIG_DIR || path.join(os.homedir(), '.ardan');
}

export function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

export function loadSettings(): Settings {
  const file = settingsPath();
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* fresh install */
  }
  const envPermissions = process.env.ARDAN_PERMISSIONS;
  return {
    defaultProvider: stored.defaultProvider || process.env.ARDAN_PROVIDER || DEFAULTS.provider,
    model:
      process.env.ARDAN_MODEL ||
      stored.model ||
      undefined,
    permissions:
      (process.env.ARDAN_PERMISSIONS as Settings['permissions']) ||
      stored.permissions ||
      'ask',
    maxTurns: Number(stored.maxTurns ?? 30),
    maxTokens: Number(stored.maxTokens ?? 8192),
    providers: stored.providers || {},
    mcpServers: stored.mcpServers || {},
    hooks: stored.hooks || {},
    reasoningEffort:
      process.env.ARDAN_REASONING_EFFORT || stored.reasoningEffort || undefined,
    alwaysThinking: Boolean(stored.alwaysThinking || process.env.ARDAN_ALWAYS_THINKING),
    maxThinkingTokens: Number(stored.maxThinkingTokens ?? 4096),
    lspServers: stored.lspServers || {},
  } satisfies Settings;
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

/* ------------------------------------------------------------------ keys */

const ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
};

export function findApiKey(provider: string, settings: Settings): string | undefined {
  const fromSettings = settings.providers?.[provider]?.apiKey;
  if (fromSettings) return fromSettings;
  const envNames = ENV_KEYS[provider] || [];
  for (const env of envNames) {
    const value = process.env[env];
    if (value) return value;
  }
  return undefined;
}

export function getApiBase(provider: string, settings: Settings): string | undefined {
  const custom = settings.providers?.[provider];
  if (custom?.apiBase) return custom.apiBase;
  switch (resolveProviderName(provider)) {
    case 'openai':
      return process.env.OPENAI_BASE_URL || providerDefaultBase('openai');
    case 'groq':
      return process.env.GROQ_BASE_URL || providerDefaultBase('groq');
    case 'mistral':
      return process.env.MISTRAL_BASE_URL || providerDefaultBase('mistral');
    case 'openrouter':
      return process.env.OPENROUTER_BASE_URL || providerDefaultBase('openrouter');
    case 'deepseek':
      return providerDefaultBase('deepseek');
    case 'ollama':
      return (
        process.env.ARDAN_OLLAMA_BASE_URL ||
        process.env.OLLAMA_BASE_URL ||
        providerDefaultBase('ollama')
      );
    case 'anthropic': {
      const a = process.env.ANTHROPIC_BASE_URL;
      if (a) return a.replace(/\/v1\/?$/, '');
      return providerDefaultBase('anthropic');
    }
    default:
      return custom?.apiBase;
  }
}

const BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

function providerDefaultBase(name: string): string | undefined {
  return BASE_URLS[name];
}

export const defaultModels = PROVIDER_META;

export function defaultModelFor(provider: string): string {
  const env = process.env['ARDAN_MODEL'];
  if (env) return env;
  switch (provider) {
    case 'ollama':
      return 'qwen2.5-coder:14b';
    case 'anthropic':
      return 'claude-sonnet-4-5';
    case 'gemini':
      return 'gemini-2.5-flash';
    case 'openai':
      return 'gpt-4.1';
    case 'groq':
      return 'llama-3.3-70b-versatile';
    case 'mistral':
      return 'codestral-latest';
    case 'openrouter':
      return 'deepseek/deepseek-chat';
    case 'deepseek':
      return 'deepseek-chat';
    default:
      return 'gpt-4.1';
  }
}

/* ----------------------------------------------------------- constructing */

export function createProvider(
  providerName: string,
  modelOverride: string | undefined,
  settings: Settings,
): Provider {
  const name = resolveProviderName(providerName);
  const model = modelOverride || settings.providers?.[name]?.model || defaultModelFor(name);
  const meta = { name, model };

  if (name === 'ollama') {
    return new OllamaProvider(meta, getApiBase(name, settings) as string);
  }
  if (name === 'anthropic') {
    const key = findApiKey(name, settings);
    if (!key) throw new Error(`ANTHROPIC_API_KEY is not set. Export it or save with: ardan keys set anthropic`);
    return new AnthropicProvider(meta, key, getApiBase(name, settings), {
      maxTokens: settings.maxTokens,
      alwaysThinking: settings.alwaysThinking,
      maxThinkingTokens: settings.maxThinkingTokens,
    });
  }
  if (name === 'gemini') {
    const key = findApiKey(name, settings);
    if (!key) throw new Error(`GEMINI_API_KEY is not set. Export it or save with: ardan keys set gemini`);
    return new GeminiProvider(meta, key, {
      maxTokens: settings.maxTokens,
      maxThinkingTokens: settings.alwaysThinking ? settings.maxThinkingTokens : undefined,
    });
  }

  // OpenAI-compatible family (incl. custom providers).
  const key = findApiKey(name, settings);
  const base = getApiBase(name, settings);
  if (!key && !base?.includes('localhost')) {
    throw new Error(
      `API key for '${name}' not found. Set the env var, or save with: ardan keys set ${name}`,
    );
  }
  const headers: Record<string, string> = {};
  if (name === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/ardan-cli';
    headers['X-Title'] = 'Ardan';
  }
  return new OpenAICompatProvider(
    meta,
    base as string,
    key as string,
    headers,
    settings.reasoningEffort,
    settings.maxTokens,
  );
}

/** Highest-priority chain for failover. */
export function failoverChain(settings: Settings, primary: string): string[] {
  const chain = [primary];
  for (const candidate of ['ollama', 'groq', 'deepseek']) {
    if (!chain.includes(candidate)) chain.push(candidate);
  }
  return chain;
}

/** Probe ollama without throwing. */
export function ollamaReachable(base: string): boolean {
  try {
    const probe = spawnSync(
      'node',
      ['-e', `fetch('${base}/api/tags').then(r=>process.exit(0)).catch(()=>process.exit(1))`],
      { timeout: 4000 },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

export function autoPickProvider(settings: Settings): string {
  const pref = resolveProviderName(settings.defaultProvider);
  if (pref !== 'ollama') {
    if (findApiKey(pref, settings)) return pref;
  } else if (ollamaReachable(getApiBase('ollama', settings) as string)) {
    return 'ollama';
  }
  for (const name of ['ollama', 'anthropic', 'openai', 'gemini', 'groq', 'mistral', 'openrouter']) {
    if (name === pref) continue;
    if (name === 'ollama') {
      if (ollamaReachable(getApiBase('ollama', settings) as string)) return name;
      continue;
    }
    if (findApiKey(name, settings)) return name;
  }
  return 'ollama';
}
