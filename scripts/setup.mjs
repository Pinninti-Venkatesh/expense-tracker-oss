#!/usr/bin/env node
/**
 * Guided setup for the Google sign-in path (MAIL_ACCESS=google): asks a few
 * plain questions, makes the Google Cloud parts it can with gcloud, and writes
 * .env, so nobody has to edit a config file by hand.
 *
 *   npm run setup:google
 *
 * The simple path needs none of this: ./setup.sh starts the app and it is set
 * up in the browser.
 *
 * Run it again any time to change an answer: it shows what's already set and
 * keeps whatever you don't change. Secrets are typed hidden, stored only in
 * .env on this machine (readable by your user alone), and never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

/* ---------- .env reading and writing (exported for tests) ---------- */

/** Parses KEY=value lines, honouring the quotes quoteEnv writes. */
export function parseEnv(text) {
  const values = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === "'" || q === '"' || q === '`') && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    values[m[1]] = v;
  }
  return values;
}

/**
 * A value quoted so dotenv reads it back exactly: single quotes are literal, so
 * they're used unless the value itself contains one.
 */
export function quoteEnv(value) {
  const v = String(value ?? '');
  if (v === '') return '';
  if (/^[A-Za-z0-9_@.:/+,=-]+$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\')) return `"${v}"`;
  return `\`${v}\``;
}

const SECTIONS = [
  ['How it reads email', ['MAIL_ACCESS']],
  ['Who can sign in', ['ALLOWED_EMAILS']],
  ['Google sign-in', ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']],
  ['Claude', ['AI_PROVIDER', 'ANTHROPIC_API_KEY']],
  ['Bank statements', ['UPI_STATEMENT_PASSWORD']],
  ['Secrets (generated; back up TOKEN_ENCRYPTION_KEY)', ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'CRON_SECRET']],
  ['Behaviour', ['APP_TIMEZONE', 'POLL_INTERVAL_MINUTES', 'USER_STORE', 'USER_STORE_FILE', 'LEDGER_DIR']],
];

/** The .env text: the wizard's settings in order, then anything else already there. */
export function serializeEnv(values) {
  const out = ['# Written by `npm run setup:google`. Run it again to change anything.', ''];
  const done = new Set();
  for (const [title, keys] of SECTIONS) {
    const present = keys.filter((k) => values[k] !== undefined);
    if (!present.length) continue;
    out.push(`# ${title}`);
    for (const k of present) { out.push(`${k}=${quoteEnv(values[k])}`); done.add(k); }
    out.push('');
  }
  const rest = Object.keys(values).filter((k) => !done.has(k));
  if (rest.length) {
    out.push('# Other settings');
    for (const k of rest) out.push(`${k}=${quoteEnv(values[k])}`);
    out.push('');
  }
  return out.join('\n');
}

/* ---------- checks (exported for tests) ---------- */

export const checks = {
  emails(text) {
    const list = String(text).split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return { error: 'Enter at least one Google account.' };
    const bad = list.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    return bad ? { error: `"${bad}" doesn't look like an email address.` } : { value: [...new Set(list)].join(',') };
  },
  address(text) {
    let url;
    try {
      url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
    } catch {
      return { error: "That doesn't look like a web address." };
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      return { error: 'Use https:// for anything other than this computer (localhost). Google refuses plain http.' };
    }
    return { value: `${url.protocol}//${url.host}` };
  },
  clientId(text) {
    const v = String(text).trim();
    return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v)
      ? { value: v }
      : { error: 'A Client ID ends in .apps.googleusercontent.com. Copy it from the Clients page.' };
  },
  clientSecret(text) {
    const v = String(text).trim();
    return /^GOCSPX-[A-Za-z0-9_-]{20,}$/.test(v) ? { value: v } : { error: 'A client secret starts with GOCSPX-.' };
  },
  claudeKey(text) {
    const v = String(text).trim();
    return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v) ? { value: v } : { error: 'A Claude API key starts with sk-ant-.' };
  },
};

/** Asks Anthropic whether the key works. Free: it only lists models. */
export async function verifyClaudeKey(key, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'Anthropic says this key is not valid.' };
    if (res.status === 403) return { ok: false, reason: "This key isn't allowed to use the API." };
    return { ok: null, reason: `Anthropic answered ${res.status}; the key may still be fine.` };
  } catch {
    return { ok: null, reason: "Couldn't reach Anthropic to check the key (offline?). It was saved anyway." };
  }
}

/* ---------- the terminal ---------- */

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const green = c('32');
const red = c('31');
const blue = c('34');

let rl;
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

/**
 * Hidden input: what's typed shows as dots. The line editor is closed while
 * this runs, because it echoes every keypress itself, and reopened after.
 */
function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    rl.close();
    process.stdout.write(q);
    let value = '';
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          process.stdout.write('\n');
          rl = readline.createInterface({ input: stdin, output: process.stdout });
          resolve(value);
          return;
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** Asks until `check` accepts the answer. Enter keeps `current` when there is one. */
async function askUntil(label, check, { current, hidden = false, shownAs } = {}) {
  for (;;) {
    const hint = current ? dim(` [Enter keeps ${shownAs ?? current}]`) : '';
    const answer = hidden ? await askHidden(`${label}${hint}: `) : await ask(`${label}${hint}: `);
    if (!answer && current) return current;
    const result = check(answer);
    if (result.value !== undefined) return result.value;
    console.log(red(`  ${result.error}`));
  }
}

const yes = async (q, def = true) => {
  const a = (await ask(`${q} ${dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
  return a ? a.startsWith('y') : def;
};

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}

const step = (n, total, title) => console.log(`\n${blue(bold(`Step ${n} of ${total}`))} ${bold(title)}`);
const say = (text) => console.log(text.replace(/^/gm, '  '));
const masked = (v) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '');

/* ---------- Google Cloud, as far as a script can go ---------- */

/** Console pages, opened on the right project when there is one. */
export function consoleUrl(page, project) {
  const url = new URL(`https://console.cloud.google.com/${page}`);
  if (project) url.searchParams.set('project', project);
  return url.toString();
}

export const newProjectId = () => `expenses-${crypto.randomBytes(3).toString('hex')}`;

function gcloud(args, { inherit = false } = {}) {
  const run = spawnSync('gcloud', args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  return { ok: run.status === 0, out: (run.stdout || '').trim(), err: (run.stderr || '').trim() };
}

const hasGcloud = () => spawnSync('gcloud', ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * Does with the gcloud tool what Google allows a script to do: sign in, create
 * a project, and turn on the Gmail and Drive APIs. Returns the project id, or
 * null when the person should do these by hand.
 */
async function automateGoogleCloud(existingProject) {
  if (!hasGcloud()) return null;
  say('The Google Cloud tool (gcloud) is installed, so the first part can be done for you.');
  if (!await yes('  Use it?')) return null;

  let account = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']).out.split('\n')[0];
  if (!account) {
    say(dim('A browser window opens: sign in to the Google account that will own the project.'));
    if (!gcloud(['auth', 'login', '--brief'], { inherit: true }).ok) return null;
    account = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']).out.split('\n')[0];
  }
  say(dim(`Signed in to Google Cloud as ${account}.`));

  let project = existingProject;
  if (project && !gcloud(['projects', 'describe', project, '--format=value(projectId)']).ok) project = null;
  if (!project) {
    project = newProjectId();
    process.stdout.write(dim(`  Creating project ${project}… `));
    const made = gcloud(['projects', 'create', project, '--name=Expenses']);
    if (!made.ok) {
      console.log(red('not created.'));
      say(dim(made.err.split('\n').slice(-3).join('\n')));
      say("Google said no (often: its terms haven't been accepted on this account yet,\nor the project limit is reached). Follow the steps below by hand instead.");
      return null;
    }
    console.log(green('done.'));
  }

  process.stdout.write(dim('  Turning on the Gmail and Drive APIs… '));
  const enabled = gcloud(['services', 'enable', 'gmail.googleapis.com', 'drive.googleapis.com', `--project=${project}`]);
  if (!enabled.ok) {
    console.log(red('failed.'));
    say(dim(enabled.err.split('\n').slice(-3).join('\n')));
    return null;
  }
  console.log(green('done.'));
  return project;
}

/** One console page at a time: open it, say what to do there, wait for Enter. */
async function consolePage(n, url, lines) {
  console.log(`\n  ${bold(`${n}.`)} ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`     ${line}`);
  console.log(`     ${dim(url)}`);
  openInBrowser(url);
  await ask(dim('     Press Enter when done. '));
}

async function googleSignInApp(v, existing) {
  say([
    'Google needs a private "sign-in app" for anything that reads Gmail this way.',
    'It is free, and Google does not review it for personal use.',
    '',
  ].join('\n'));
  const project = await automateGoogleCloud(existing.GOOGLE_CLOUD_PROJECT);
  if (project) v.GOOGLE_CLOUD_PROJECT = project;

  const emails = v.ALLOWED_EMAILS.split(',').join(', ');
  say(`\n${project ? 'Four' : 'Five'} pages in your browser are left, each opened for you in turn.`);
  let n = 0;
  if (!project) {
    await consolePage(++n, 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,drive.googleapis.com', [
      'Create a project and turn on Gmail and Drive.',
      `Choose ${bold('Create a project')} (any name), then ${bold('Next')} and ${bold('Enable')}.`,
    ]);
  }
  await consolePage(++n, consoleUrl('auth/overview', project), [
    `Tap ${bold('Get started')}.`,
    `App name: ${bold('Expenses')}. Support email: yours. Audience: ${bold('External')}.`,
    'Contact email: yours. Tick the agreement, then Create.',
  ]);
  await consolePage(++n, consoleUrl('auth/scopes', project), [
    `Tap ${bold('Add or remove scopes')}, and add these two (paste each in the filter):`,
    `${green('https://www.googleapis.com/auth/gmail.readonly')}`,
    `${green('https://www.googleapis.com/auth/drive.file')}`,
    `Tap ${bold('Update')}, then ${bold('Save')}.`,
  ]);
  await consolePage(++n, consoleUrl('auth/audience', project), [
    `Under ${bold('Test users')}, tap ${bold('Add users')} and add:`,
    green(emails),
  ]);
  await consolePage(++n, consoleUrl('auth/clients/create', project), [
    `Application type: ${bold('Web application')}.`,
    `Under ${bold('Authorized redirect URIs')}, tap Add URI and paste exactly:`,
    green(v.GOOGLE_REDIRECT_URI),
    `Tap ${bold('Create')}. Keep that window open: the next two questions are from it.`,
  ]);

  v.GOOGLE_CLIENT_ID = await askUntil('Client ID', checks.clientId, { current: existing.GOOGLE_CLIENT_ID });
  v.GOOGLE_CLIENT_SECRET = await askUntil('Client secret', checks.clientSecret, {
    current: existing.GOOGLE_CLIENT_SECRET, hidden: true, shownAs: masked(existing.GOOGLE_CLIENT_SECRET),
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Run this in a terminal: it asks questions. (npm run setup:google)');
    process.exit(1);
  }
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const existing = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {};
  const v = { ...existing };
  const before = Boolean(existing.GOOGLE_CLIENT_ID);

  console.log(`\n${bold('Expense Tracker setup: Google sign-in')}`);
  say(dim(before
    ? 'You have set this up before. Press Enter on anything you want to keep.'
    : "About 10 minutes. You'll need a Google account and a Claude API key.\nFor the simple path, run ./setup.sh instead: it needs none of this."));

  v.MAIL_ACCESS = 'google';
  const TOTAL = 4;
  let n = 0;

  // Who
  step(++n, TOTAL, 'Who will use it?');
  say('The Gmail accounts allowed to sign in: you, and anyone in your household.\nSeparate several with commas.');
  v.ALLOWED_EMAILS = await askUntil('Emails', checks.emails, { current: existing.ALLOWED_EMAILS || existing.BETA_ALLOWED_EMAILS });
  delete v.BETA_ALLOWED_EMAILS;

  let base = 'http://localhost:8080';
  {
    // Where
    step(++n, TOTAL, 'Where will you open it?');
    say('Press Enter if you will use it on this computer. If you have your own web\naddress for it, type that instead (for example https://expenses.example.com).');
    const currentBase = existing.GOOGLE_REDIRECT_URI ? existing.GOOGLE_REDIRECT_URI.replace(/\/api\/login\/callback$/, '') : base;
    base = await askUntil('Address', checks.address, { current: currentBase });
    v.GOOGLE_REDIRECT_URI = `${base}/api/login/callback`;

    // Google
    step(++n, TOTAL, 'Your Google sign-in app');
    await googleSignInApp(v, existing);
  }

  // Claude
  step(++n, TOTAL, 'Claude, which reads your bank alerts');
  say([
    'Create a key at console.anthropic.com → Settings → API keys, and add a little',
    'credit. Reading two months of alerts the first time costs roughly ₹50–100; after',
    'that the app learns your banks\' formats and it costs a few rupees a month.',
  ].join('\n'));
  if (!existing.ANTHROPIC_API_KEY && await yes('\n  Open the Claude console in your browser now?')) openInBrowser('https://console.anthropic.com/settings/keys');
  for (;;) {
    const key = await askUntil('Claude API key', checks.claudeKey, {
      current: existing.ANTHROPIC_API_KEY, hidden: true, shownAs: masked(existing.ANTHROPIC_API_KEY),
    });
    process.stdout.write(dim('  Checking the key with Anthropic… '));
    // SETUP_SKIP_KEY_CHECK is for exercising the wizard offline with a made-up key.
    const check = process.env.SETUP_SKIP_KEY_CHECK ? { ok: null, reason: 'Not checked.' } : await verifyClaudeKey(key);
    if (check.ok) { console.log(green('works.')); v.ANTHROPIC_API_KEY = key; break; }
    if (check.ok === null) { console.log(dim(check.reason)); v.ANTHROPIC_API_KEY = key; break; }
    console.log(red(check.reason));
    existing.ANTHROPIC_API_KEY = undefined;
  }
  v.AI_PROVIDER ||= 'anthropic';

  // Statement passwords are remembered per person in the app now (Add UPI
  // spends → "Remember"). UPI_STATEMENT_PASSWORD from an earlier run is kept.

  // The rest, decided for you.
  const newKey = !existing.TOKEN_ENCRYPTION_KEY;
  v.SESSION_SECRET ||= crypto.randomBytes(32).toString('hex');
  v.TOKEN_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
  v.CRON_SECRET ||= crypto.randomBytes(32).toString('hex');
  // macOS still reports India's old zone name; both work, the new one reads better.
  v.APP_TIMEZONE ||= (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata').replace('Asia/Calcutta', 'Asia/Kolkata');
  v.POLL_INTERVAL_MINUTES ||= '10';
  v.USER_STORE ||= 'file';
  v.USER_STORE_FILE ||= 'data/users.json';

  if (fs.existsSync(ENV_PATH)) fs.copyFileSync(ENV_PATH, `${ENV_PATH}.previous`);
  fs.writeFileSync(ENV_PATH, serializeEnv(v), { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);

  console.log(`\n${green(bold('Saved.'))} Your settings are in .env, readable only by you.`);
  if (newKey) {
    say(dim('Keep a copy of the .env file somewhere safe. Without it, everyone has to sign in\nagain; your spends are safe either way, in each person\'s Google Drive.'));
  }

  // Start it.
  const docker = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
  console.log('');
  if (docker && await yes('Start the app now with Docker?')) {
    const run = spawnSync('docker', ['compose', 'up', '-d', '--build'], { cwd: ROOT, stdio: 'inherit' });
    if (run.status === 0) {
      console.log(`\n${green(bold('Running.'))} Open ${bold(base)} and continue with Google.`);
    } else {
      console.log(red('\nDocker could not start it. The messages above say why.'));
    }
  } else {
    say(`To start it: ${bold(docker ? 'docker compose up -d' : 'npm start')}, then open ${bold(base)}.`);
  }
  say(dim('Run `npm run setup:google` again any time to change an answer.'));
  rl.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(red(`\nSetup stopped: ${err.message}`));
    process.exit(1);
  });
}
