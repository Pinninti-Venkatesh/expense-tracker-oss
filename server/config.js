import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();

const list = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const flag = (name) => /^(1|true|yes|on)$/i.test(process.env[name] || '');
const isProduction = process.env.NODE_ENV === 'production';

// Everything an install keeps lives in one folder: accounts, ledgers, settings
// made in the app, and the secrets below. Moving or backing up an install is
// copying this folder (/data in the container).
const dataDir = process.env.DATA_DIR || 'data';

// Cloud Run (which sets K_SERVICE) wipes its own disk. PERSISTENT_DATA_DIR says
// the data folder is a mounted volume that survives (a storage bucket), and
// EPHEMERAL_STORE that losing it is intended, as in the public demo.
const diskSurvives = () => !process.env.K_SERVICE || flag('PERSISTENT_DATA_DIR') || flag('EPHEMERAL_STORE');

/**
 * The install's own secrets, made on first start and kept in the data folder,
 * so nobody has to generate or paste them. Anything set in the environment
 * wins. Not on a disk that is wiped, where they would change on every restart
 * and sign everyone out.
 */
function installSecrets() {
  const wanted = ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'CRON_SECRET'];
  if (wanted.every((k) => process.env[k]) || !diskSurvives() || process.env.USER_STORE === 'firestore') return {};
  const file = path.join(dataDir, 'secrets.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first start
  }
  const made = {
    SESSION_SECRET: saved.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    TOKEN_ENCRYPTION_KEY: saved.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64'),
    CRON_SECRET: saved.CRON_SECRET || crypto.randomBytes(32).toString('hex'),
  };
  if (wanted.some((k) => saved[k] !== made[k])) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ ...saved, ...made }, null, 2), { mode: 0o600 });
  }
  return made;
}
const secrets = installSecrets();
const secret = (name) => process.env[name] || secrets[name];

const config = {
  isProduction,

  // A self-hosted install serves one household and needs none of these; they
  // exist for running the app as a paid, public service. All off by default.
  features: {
    // 14-day trial, paywall and Razorpay subscriptions (billing/).
    billing: flag('BILLING_ENABLED'),
    // Bank email formats shared across accounts once enough learn them
    // (templates/library.js). Needs several unrelated accounts to do anything.
    sharedTemplates: flag('SHARED_TEMPLATES_ENABLED'),
    // /privacy and /terms, and the "you agree to…" line on the welcome screens.
    legalPages: flag('LEGAL_PAGES_ENABLED'),
  },

  product: {
    name: process.env.PRODUCT_NAME || 'Expense Tracker',
    supportEmail: process.env.SUPPORT_EMAIL || '',
  },

  legal: {
    // Stored on each account at sign-up, so a later policy change can tell who
    // agreed to which version.
    policyVersion: process.env.POLICY_VERSION || '2026-09-draft',
    operatorName: process.env.OPERATOR_NAME || '',
    effectiveDate: process.env.POLICY_EFFECTIVE_DATE || '',
  },

  mail: {
    // How the app reaches each person's Gmail.
    //   'app-password'  Gmail over IMAP with an app password each person makes
    //                   in their Google account: no Google Cloud project at all.
    //                   Ledgers are kept on this machine (LEDGER_DIR).
    //   'google'        Google sign-in with read-only Gmail and the app's own
    //                   Drive file: more setup, narrower access.
    // Unset picks 'google' when an OAuth client is configured.
    access: (process.env.MAIL_ACCESS || (process.env.GOOGLE_CLIENT_ID ? 'google' : 'app-password')).toLowerCase(),
  },

  dataDir,

  ledger: {
    // Where app-password installs keep each person's ledger, one JSON file each.
    dir: process.env.LEDGER_DIR || path.join(dataDir, 'ledgers'),
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Must exactly match an Authorized redirect URI on the OAuth client.
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8080/api/login/callback',
  },

  ai: {
    // Which Claude to call. 'anthropic' is Anthropic's own API: one key and
    // nothing else to set up, which is what this experiment runs on.
    // 'bedrock' is Claude on Amazon Bedrock, where AWS runs inference with no
    // operator access and does not store prompts — the right answer once the
    // product holds enough other people's bank alerts to be worth the setup.
    // Switching is this one variable plus that provider's credentials: only
    // llm/client.js knows which is in use, and the user-facing copy (welcome
    // screens, statement import, privacy policy) follows `vendor` below.
    provider: (process.env.AI_PROVIDER || 'anthropic').toLowerCase(),
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    },
    bedrock: {
      // Mumbai offers Claude through Bedrock's global endpoint only, so requests
      // may be served from another region. See docs/self-hosting.md before promising residency.
      region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-south-1',
      model: process.env.BEDROCK_MODEL || 'anthropic.claude-haiku-4-5',
    },
  },

  drive: {
    // Name of the ledger file created in each user's own Drive. Give each copy
    // of the app its own name: one Google account may use two copies, and two
    // files with one name in a Drive is a trap.
    fileName: process.env.DRIVE_FILE_NAME || 'expenses-app-ledger.json',
  },

  session: {
    secret: secret('SESSION_SECRET'),
  },

  security: {
    // 32 random bytes, base64. Encrypts every stored refresh token, app
    // password, statement password and the Claude key set in the app.
    tokenEncryptionKey: secret('TOKEN_ENCRYPTION_KEY'),
  },

  users: {
    // 'file' keeps accounts in a local JSON file (development only);
    // 'firestore' is required anywhere the disk is not durable, like Cloud Run.
    // 'file' keeps accounts in the data folder; 'firestore' is for Cloud Run
    // without a mounted volume.
    backend: process.env.USER_STORE || 'file',
    filePath: process.env.USER_STORE_FILE || path.join(dataDir, 'users.json'),
    collection: process.env.FIRESTORE_COLLECTION || 'accounts',
    // The Google accounts allowed to sign in: you and your household.
    // BETA_ALLOWED_EMAILS is the old name, still read.
    allowlist: list(process.env.ALLOWED_EMAILS || process.env.BETA_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
    // Anyone with a Google account may sign up. Only for a public service:
    // every account reads email with your Claude key.
    openSignup: flag('OPEN_SIGNUP'),
    // Refuse new accounts past this many (0 = no cap). An unverified Google app
    // can only ever sign up 100 users in its lifetime.
    maxUsers: int(process.env.MAX_USERS, 0),
  },

  store: {
    // Ledgers kept in memory at once. Least recently used accounts are dropped
    // past this and re-read from Drive on their next request.
    maxCachedAccounts: int(process.env.MAX_CACHED_ACCOUNTS, 200),
  },

  pin: {
    idleMinutes: int(process.env.PIN_IDLE_MINUTES, 15),
  },

  trial: {
    // Days a new account is free. After that the app asks for a subscription
    // (billing/gate.js) and the scheduled poll skips the account.
    days: int(process.env.TRIAL_DAYS, 14),
  },

  billing: {
    // Razorpay: Dashboard > Account & Settings > API Keys. Test-mode keys
    // (rzp_test_…) for development.
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    // Set on the webhook in the Razorpay dashboard; signs every delivery.
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    // Plan ids created in the dashboard (Subscriptions > Plans). Prices and
    // periods are read from Razorpay, never set in code.
    plans: {
      monthly: process.env.RAZORPAY_PLAN_MONTHLY || '',
      yearly: process.env.RAZORPAY_PLAN_YEARLY || '',
    },
    // Billing cycles before a subscription completes; Razorpay requires one.
    // After the last cycle the customer subscribes again.
    totalCount: {
      monthly: int(process.env.RAZORPAY_MONTHLY_CYCLES, 120),
      yearly: int(process.env.RAZORPAY_YEARLY_CYCLES, 10),
    },
  },

  library: {
    // Accounts that must learn the same bank email format independently before
    // it is shared with everyone. See templates/library.js.
    minContributors: Math.max(2, int(process.env.TEMPLATE_LIBRARY_MIN_ACCOUNTS, 3)),
    collection: process.env.TEMPLATE_LIBRARY_COLLECTION || 'templateLibrary',
    filePath: process.env.TEMPLATE_LIBRARY_FILE || path.join(dataDir, 'template-library.json'),
  },

  onboarding: {
    // Until Google verifies the OAuth app, sign-in shows "Google hasn't verified
    // this app", and the welcome screens explain it. Set true once verified.
    googleVerified: process.env.GOOGLE_APP_VERIFIED === 'true',
  },

  server: {
    port: int(process.env.PORT, 8080),
  },

  cron: {
    secret: secret('CRON_SECRET'),
  },

  poll: {
    // How far back each routine poll re-reads. Overlap is free — processedEmailIds
    // skips anything already decided — and it is the only guard against an outage
    // leaving transactions permanently unseen.
    lookbackHours: int(process.env.POLL_LOOKBACK_HOURS, 24),
    // New emails one routine poll reads at most. Only matters when catching up
    // after downtime: the rest are read by the next poll, or by the app, which
    // keeps asking while there's more.
    batchSize: Math.max(1, int(process.env.POLL_BATCH_SIZE, 60)),
    // Accounts polled at once by the scheduled job.
    concurrency: Math.max(1, int(process.env.POLL_CONCURRENCY, 4)),
    // Check every account's email on a timer inside the server (0 = off, as on
    // Cloud Run, where Cloud Scheduler calls /api/cron/poll instead).
    intervalMinutes: Math.max(0, int(process.env.POLL_INTERVAL_MINUTES, 10)),
  },

  upi: {
    // Extra senders to search for statement PDFs, on top of any email whose
    // subject looks like a bank statement. Any bank's layout can be read.
    statementSenders: list(process.env.UPI_STATEMENT_SENDER || 'fedmail@federal.bank.in,noreply@jupiter.money')
      .map((v) => v.toLowerCase()),
    // Statement passwords kept for automatic import on every poll, tried in
    // turn (comma-separated), the way a personal install reads statements.
    // Empty (the default) = never stored: passwords are typed per import.
    statementPasswords: list(process.env.UPI_STATEMENT_PASSWORD),
    // Optional floor: statement rows dated before this are never imported.
    since: process.env.UPI_STATEMENT_SINCE || null,
  },

  forex: {
    // A card's cross-currency fee: a markup on the converted amount, plus GST on
    // that markup. Defaults match common Indian credit cards.
    markupPct: Number(process.env.FOREX_MARKUP_PCT ?? 3.5),
    gstOnMarkupPct: Number(process.env.FOREX_GST_ON_MARKUP_PCT ?? 18),
  },
};

/**
 * Fails fast on missing or unsafe configuration. Security settings fail closed:
 * a missing secret must stop the server, never quietly serve financial data.
 */
export function assertConfigured() {
  if (!['google', 'app-password'].includes(config.mail.access)) {
    throw new Error(`MAIL_ACCESS must be "app-password" or "google", not "${config.mail.access}"`);
  }

  const missing = config.mail.access !== 'google' ? [] : [
    ['GOOGLE_CLIENT_ID', config.google.clientId],
    ['GOOGLE_CLIENT_SECRET', config.google.clientSecret],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. Run ./setup.sh, or copy .env.example to .env and fill them in.`);
  }

  if (!config.session.secret || config.session.secret.length < 32) {
    throw new Error(
      'SESSION_SECRET must be at least 32 random characters. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  if (Buffer.from(config.security.tokenEncryptionKey || '', 'base64').length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  if (!AI_VENDORS[config.ai.provider]) {
    throw new Error(`AI_PROVIDER must be "anthropic" or "bedrock", not "${config.ai.provider}"`);
  }

  // Bedrock credentials can come from an instance role, so there is nothing to
  // check for; an Anthropic key has to be present or every model call fails.
  // An app-password install is the exception: its owner enters the key on the
  // first-run screen (install.js), so starting without one is expected.
  if (config.ai.provider === 'anthropic' && !config.ai.anthropic.apiKey && config.mail.access !== 'app-password') {
    throw new Error('ANTHROPIC_API_KEY is not set. Set it, or set AI_PROVIDER=bedrock to call Claude on Amazon Bedrock instead.');
  }

  if (!['file', 'firestore'].includes(config.users.backend)) {
    throw new Error(`USER_STORE must be "file" or "firestore", not "${config.users.backend}"`);
  }

  // Cloud Run (which sets K_SERVICE) wipes its disk whenever it recycles a
  // container, unless the data folder is a mounted bucket (PERSISTENT_DATA_DIR).
  // A server or Docker volume keeps it, so the file store is fine there.
  if (!diskSurvives() && config.users.backend === 'file') {
    throw new Error('USER_STORE=file keeps accounts on local disk, which Cloud Run wipes. Mount a storage bucket at the data folder and set PERSISTENT_DATA_DIR=true (scripts/deploy-cloud-run.sh does both), or use USER_STORE=firestore.');
  }

  // App-password installs keep ledgers in the data folder too.
  if (!diskSurvives() && config.mail.access === 'app-password') {
    throw new Error('MAIL_ACCESS=app-password keeps ledgers in the data folder, which Cloud Run wipes. Mount a storage bucket there and set PERSISTENT_DATA_DIR=true (scripts/deploy-cloud-run.sh does both).');
  }

  // Without an allowlist, anyone who finds the URL can sign up and have their
  // email read with your Claude key. Opening sign-up must be deliberate. An
  // app-password install needs none: its owner claims it with a one-time setup
  // code, and everyone else joins through an invite (install.js).
  if (isProduction && config.mail.access !== 'app-password' && !config.users.allowlist.length && !config.users.openSignup) {
    throw new Error('Set ALLOWED_EMAILS to the Google accounts that may sign in (comma-separated), or OPEN_SIGNUP=true to let anyone sign up.');
  }

  // The paywall locks every account whose trial has ended. In production that
  // must never happen on a server with no way to pay.
  if (isProduction && config.features.billing && !config.billing.enabled) {
    throw new Error('BILLING_ENABLED is on but payments are not configured. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET and at least one of RAZORPAY_PLAN_MONTHLY / RAZORPAY_PLAN_YEARLY.');
  }
}

/**
 * How the app names its model provider to people. The welcome screens, the
 * statement import note and the privacy policy all read this, so the copy can
 * never claim one provider while the server calls another.
 */
export const AI_VENDORS = {
  anthropic: {
    label: 'Claude at Anthropic',
    retention: "It isn't used to train models.",
  },
  bedrock: {
    label: 'Claude on Amazon Bedrock',
    retention: "It isn't stored or used to train models.",
  },
};

config.ai.vendor = AI_VENDORS[config.ai.provider] || AI_VENDORS.anthropic;

// Payments run only when the feature is on and Razorpay is fully configured.
config.billing.enabled = Boolean(
  config.features.billing
  && config.billing.keyId && config.billing.keySecret && config.billing.webhookSecret
  && (config.billing.plans.monthly || config.billing.plans.yearly),
);

export default config;
