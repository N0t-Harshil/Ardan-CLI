import type { Settings } from '../types.ts';

export interface ProviderMeta {
  name: string;
  model: string;
}

export const PROVIDER_META: Record<string, string> = {
  ollama: 'qwen2.5-coder:14b (local, free)',
  anthropic: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4.1',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'codestral-latest',
  openrouter: 'deepseek/deepseek-chat',
  deepseek: 'deepseek-chat',
};

export const DEFAULTS = {
  provider: 'ollama',
} as const;

const ALIASES: Record<string, string> = {
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  gpt: 'openai',
  fast: 'groq',
};

export function resolveProviderName(name: string): string {
  const lowered = (name || '').toLowerCase().trim();
  if (ALIASES[lowered]) return ALIASES[lowered];
  return lowered;
}

export type { Settings };
