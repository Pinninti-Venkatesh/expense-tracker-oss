import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// config.js reads the environment once, at import.
Object.assign(process.env, {
  AI_PROVIDER: 'bedrock',
  ANTHROPIC_API_KEY: '',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  USER_STORE: 'file',
});

const { default: config, assertConfigured, AI_VENDORS } = await import('../server/config.js');
const { providerFor, isFatalLlmError } = await import('../server/llm/client.js');

test('the provider in use is the one AI_PROVIDER names', () => {
  assert.equal(config.ai.provider, 'bedrock');
  assert.equal(config.ai.vendor, AI_VENDORS.bedrock);
  assert.match(providerFor().explain({ status: 500 }).message, /Bedrock/);
});

test('AI_PROVIDER has to name a provider we actually have', () => {
  assert.throws(() => providerFor('openai'), /AI_PROVIDER must be one of/);
});

test('dead credentials stop the run; a rate limit does not', () => {
  for (const name of ['anthropic', 'bedrock']) {
    const { explain } = providerFor(name);
    assert.equal(isFatalLlmError(explain({ status: 401 })), true, `${name} 401`);
    assert.equal(isFatalLlmError(explain({ status: 403 })), true, `${name} 403`);
    assert.equal(isFatalLlmError(explain({ status: 429 })), false, `${name} 429`);
    assert.equal(isFatalLlmError(explain({ status: 500, message: 'upstream' })), false, `${name} 500`);
  }
});

test('an out-of-credit Anthropic account stops the run rather than retrying every email', () => {
  const err = providerFor('anthropic').explain({ status: 400, message: 'Your credit balance is too low' });
  assert.equal(isFatalLlmError(err), true);
});

test('an error re-wrapped on its way up is still recognised as fatal', () => {
  assert.equal(isFatalLlmError(new Error('The Anthropic API key is invalid or revoked')), true);
});

test('each provider is configured before the server will start', () => {
  assert.doesNotThrow(() => assertConfigured(), 'bedrock needs no key here: AWS credentials come from its own chain');

  config.ai.provider = 'anthropic';
  assert.throws(() => assertConfigured(), /ANTHROPIC_API_KEY/);

  config.ai.anthropic.apiKey = 'sk-ant-test';
  assert.doesNotThrow(() => assertConfigured());

  config.ai.provider = 'openai';
  assert.throws(() => assertConfigured(), /AI_PROVIDER must be/);
  config.ai.provider = 'bedrock';
});
