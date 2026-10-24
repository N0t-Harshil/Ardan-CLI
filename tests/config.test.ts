// Config resolution tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultModelFor } from '../src/config.ts';
import { resolveProviderName } from '../src/providers/base.ts';

test('provider aliases resolve', () => {
  assert.equal(resolveProviderName('claude'), 'anthropic');
  assert.equal(resolveProviderName('google'), 'gemini');
  assert.equal(resolveProviderName('Groq '), 'groq');
  assert.equal(resolveProviderName('ollama'), 'ollama');
});

test('default models per provider', () => {
  assert.equal(defaultModelFor('ollama'), 'qwen2.5-coder:14b');
  assert.equal(defaultModelFor('anthropic'), 'claude-sonnet-4-5');
  assert.equal(defaultModelFor('openai'), 'gpt-4.1');
});
