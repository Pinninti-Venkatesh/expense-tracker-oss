import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// config.js reads the environment once, at import, as a production server would.
Object.assign(process.env, {
  NODE_ENV: 'production',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  ANTHROPIC_API_KEY: 'sk-ant-test',
  USER_STORE: 'file',
  ALLOWED_EMAILS: '',
  OPEN_SIGNUP: '',
  BILLING_ENABLED: '',
  SHARED_TEMPLATES_ENABLED: '',
  LEGAL_PAGES_ENABLED: '',
});
delete process.env.K_SERVICE;

const { default: config, assertConfigured } = await import('../server/config.js');

beforeEach(() => {
  config.users.allowlist = ['me@example.com'];
  config.users.openSignup = false;
  config.users.backend = 'file';
  config.features.billing = false;
  config.billing.enabled = false;
  config.mail.access = 'google';
  config.google.clientId = 'test-client';
  config.google.clientSecret = 'test-secret';
  delete process.env.K_SERVICE;
});

test('every optional feature is off unless switched on', () => {
  assert.deepEqual(
    { billing: false, sharedTemplates: false, legalPages: false },
    { billing: config.features.billing, sharedTemplates: config.features.sharedTemplates, legalPages: config.features.legalPages },
  );
});

test('a self-hosted install with an allowlist and no payments starts', () => {
  assert.doesNotThrow(() => assertConfigured());
});

test('production refuses open sign-up unless it is asked for', () => {
  config.users.allowlist = [];
  assert.throws(() => assertConfigured(), /ALLOWED_EMAILS/);
  config.users.openSignup = true;
  assert.doesNotThrow(() => assertConfigured());
});

test('turning billing on without Razorpay keys stops the server', () => {
  config.features.billing = true;
  assert.throws(() => assertConfigured(), /BILLING_ENABLED is on but payments are not configured/);
  config.billing.enabled = true;
  assert.doesNotThrow(() => assertConfigured());
});

test('the file store is fine on a server, but not on Cloud Run, which wipes its disk', () => {
  assert.doesNotThrow(() => assertConfigured());
  process.env.K_SERVICE = 'expenses';
  assert.throws(() => assertConfigured(), /Cloud Run/);
  config.users.backend = 'firestore';
  assert.doesNotThrow(() => assertConfigured());
});

test('a store meant to be forgotten, like the demo, may run on Cloud Run', () => {
  process.env.K_SERVICE = 'expenses-demo';
  process.env.EPHEMERAL_STORE = 'true';
  assert.doesNotThrow(() => assertConfigured());
  delete process.env.EPHEMERAL_STORE;
});

test('an app-password install needs no Google Cloud project, no allowlist and no Claude key to start', () => {
  config.mail.access = 'app-password';
  config.google.clientId = '';
  config.google.clientSecret = '';
  config.users.allowlist = [];
  const key = config.ai.anthropic.apiKey;
  config.ai.anthropic.apiKey = '';
  assert.doesNotThrow(() => assertConfigured(), 'the owner claims it with a setup code and enters the key on the first screen');
  config.ai.anthropic.apiKey = key;

  config.mail.access = 'google';
  config.google.clientId = 'test-client';
  config.google.clientSecret = 'test-secret';
  assert.throws(() => assertConfigured(), /ALLOWED_EMAILS/, 'Google sign-in still needs its allowlist');
});

test('on Cloud Run the data folder must be a mounted bucket', () => {
  config.mail.access = 'app-password';
  process.env.K_SERVICE = 'expenses';
  config.users.backend = 'firestore';
  assert.throws(() => assertConfigured(), /keeps ledgers in the data folder, which Cloud Run wipes/);
  config.users.backend = 'file';
  process.env.PERSISTENT_DATA_DIR = 'true';
  assert.doesNotThrow(() => assertConfigured());
  delete process.env.PERSISTENT_DATA_DIR;
});

test('Google sign-in still needs its OAuth client, and a misspelt access type is caught', () => {
  config.google.clientSecret = '';
  assert.throws(() => assertConfigured(), /GOOGLE_CLIENT_SECRET/);
  config.mail.access = 'apppassword';
  assert.throws(() => assertConfigured(), /MAIL_ACCESS must be/);
});
