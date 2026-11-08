/**
 * Stand-ins for everything outside this app, for end-to-end runs: Google
 * sign-in, Gmail and Drive (the `googleapis` package), Gmail over IMAP (the
 * `imapflow` package), Claude (the
 * `@anthropic-ai/sdk` and `@anthropic-ai/bedrock-sdk` packages), and Razorpay
 * (its HTTPS API).
 *
 * The app's own code runs unchanged. setup.js swaps these in at the module
 * boundary, so every route, store, template and billing rule is the real one.
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { startOfPreviousMonth } from '../server/utils/datetime.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const unix = (ms) => Math.floor(ms / 1000);
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export const PERSONAS = {
  asha: { sub: 'g-asha', email: 'asha.rao@gmail.com', name: 'Asha Rao', card: '4417' },
  vikram: { sub: 'g-vikram', email: 'vikram.mehta@gmail.com', name: 'Vikram Mehta', card: '8812' },
  meera: { sub: 'g-meera', email: 'meera.iyer@gmail.com', name: 'Meera Iyer', card: '1034' },
  dev: { sub: 'g-dev', email: 'dev.shah@gmail.com', name: 'Dev Shah', card: '7730' },
  nisha: { sub: 'g-nisha', email: 'nisha.pillai@gmail.com', name: 'Nisha Pillai', card: '2210' },
  // Unticks Gmail and Drive on Google's consent screen.
  ravi: { sub: 'g-ravi', email: 'ravi.kumar@gmail.com', name: 'Ravi Kumar', card: '5521', identityOnly: true },
};

export const state = {
  googleBase: 'http://127.0.0.1:1',
  inboxes: new Map(), // persona key -> [message]
  drives: new Map(), // persona key -> Map(fileId -> body)
  revokedTokens: [],
  revokedPersonas: new Set(),
  model: { calls: 0, down: false },
  razorpay: { subs: new Map(), plans: new Map(), calls: [], seq: 0, autoChargeOnFetch: false },
};

/* ---------- mail ---------- */

let mailSeq = 0;

export function mail({ from, subject, body, at, dkim = true }) {
  const domain = from.split('@')[1];
  const id = `m${String(++mailSeq).padStart(5, '0')}`;
  return {
    id,
    threadId: id,
    internalDate: String(at),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Authentication-Results', value: dkim ? `mx.google.com; dkim=pass header.i=@${domain} header.s=s2048; spf=pass` : 'mx.google.com; dkim=none; spf=softfail' },
        { name: 'From', value: `Alerts <${from}>` },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(at).toUTCString() },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const rupeesText = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** HDFC Bank's credit card alert, the way the unit tests write it. */
export function hdfcAlert(key, { amount, merchant, at, ref = String(100000 + (mailSeq * 7919) % 900000), dkim = true }) {
  const p = PERSONAS[key];
  const [d, mon, y] = dayFmt.format(at).split(' ');
  return mail({
    from: 'alerts@hdfcbank.net',
    subject: 'Alert : Update on your HDFC Bank Credit Card',
    body: `Dear ${p.name},\nRs.${rupeesText(amount)} has been debited on your HDFC Bank Credit Card ending ${p.card} towards ${merchant} on ${d} ${mon}, ${y} at ${timeFmt.format(at)}.\nAuthorization code:- ${ref}\nIf you have not done this transaction, please call 18002586161.\nWarm Regards, HDFC Bank`,
    at,
    dkim,
  });
}

/** ICICI Bank's card alert: a second, different layout. */
export function iciciAlert(key, { amount, merchant, at, dkim = true }) {
  const p = PERSONAS[key];
  const date = dayFmt.format(at).replace(/ /g, '-');
  return mail({
    from: 'credit_cards@icicibank.com',
    subject: 'Transaction alert for your ICICI Bank Credit Card',
    body: `INR ${rupeesText(amount)} spent using ICICI Bank Card XX${p.card} on ${date} on ${merchant}. Avl Limit: INR 2,34,567.00. If not you, call 1800 2662 to block your card.`,
    at,
    dkim,
  });
}

export const MERCHANTS = ['SWIGGY BANGALORE IN', 'ZEPTO MARKETPLACE PVT', 'UBER INDIA SYSTEMS', 'AMAZON PAY INDIA'];
const AMOUNTS = [642, 1299, 386, 2499, 455, 1840, 212, 3120, 745, 999.5, 158, 2210, 610, 1375];

/**
 * A believable inbox for one person: `count` spends spread from the 2nd of last
 * month to an hour ago, plus the cases the first sync must get right.
 */
export function buildInbox(key, { count = 14, now = Date.now(), alert = hdfcAlert, dkim = true } = {}) {
  const start = startOfPreviousMonth(now);
  const from = start + DAY;
  const span = now - HOUR - from;
  const spends = Array.from({ length: count }, (_, i) => alert(key, {
    amount: AMOUNTS[i % AMOUNTS.length],
    merchant: MERCHANTS[i % MERCHANTS.length],
    at: from + Math.floor((span * i) / Math.max(1, count - 1)),
    dkim,
  }));
  const first = spends[3];
  const duplicate = { ...structuredClone(first), id: `m${String(++mailSeq).padStart(5, '0')}`, internalDate: String(Number(first.internalDate) + 2 * MIN) };

  const edge = {
    // 00:10 on the 1st of last month, India time: inside the window.
    firstMinute: alert(key, { amount: 310, merchant: 'UBER INDIA SYSTEMS', at: start + 10 * MIN, dkim }),
    // 23:10 the night before: outside it.
    beforeWindow: alert(key, { amount: 999, merchant: 'SWIGGY BANGALORE IN', at: start - 50 * MIN, dkim }),
    otp: mail({ from: 'alerts@hdfcbank.net', subject: 'OTP for your transaction', body: 'Your OTP is 482913 for a transaction of Rs.2,499.00 at AMAZON. Do not share it with anyone.', at: start + 3 * DAY }),
    promo: mail({ from: 'offers@hdfcbank.net', subject: 'Festive offer on your card', body: 'Get Rs.500 cashback when you spend Rs.5,000 this week. T&C apply.', at: start + 4 * DAY }),
    duplicate,
  };

  const messages = [...spends, ...Object.values(edge)];
  state.inboxes.set(key, messages);
  return { spends, edge, expectedSpends: count + 1 };
}

export function deliverMail(key, message) {
  const inbox = state.inboxes.get(key) || [];
  inbox.push(message);
  state.inboxes.set(key, inbox);
  return message;
}

/* ---------- sandboxes (the public demo) ---------- */

/**
 * A private copy of a persona for one demo visitor: its own key, Google id,
 * inbox and Drive, so visitors never see or lock each other's data. Fuller than
 * a test inbox: six weeks of spends across every merchant.
 */
export function sandboxPersona(baseKey) {
  const base = PERSONAS[baseKey];
  if (!base || base.identityOnly) throw new Error(`No demo persona "${baseKey}"`);
  const tag = crypto.randomBytes(4).toString('hex');
  const key = `${baseKey}-${tag}`;
  const [user, domain] = base.email.split('@');
  PERSONAS[key] = { ...base, sub: `g-${key}`, email: `${user}+${tag}@${domain}`, sandboxOf: baseKey, createdAt: Date.now() };
  buildInbox(key, { count: 40, alert: baseKey === 'nisha' ? iciciAlert : hdfcAlert });
  return PERSONAS[key];
}

/** Sandboxes older than `ms`, oldest first. */
export const staleSandboxes = (ms, now = Date.now()) => Object.entries(PERSONAS)
  .filter(([, p]) => p.sandboxOf && now - p.createdAt > ms)
  .sort(([, a], [, b]) => a.createdAt - b.createdAt)
  .map(([key, p]) => ({ key, sub: p.sub }));

export const sandboxCount = () => Object.values(PERSONAS).filter((p) => p.sandboxOf).length;

/** Forgets a sandbox's fake Google side: persona, inbox and Drive. */
export function forgetSandbox(key) {
  if (!PERSONAS[key]?.sandboxOf) return;
  delete PERSONAS[key];
  state.inboxes.delete(key);
  state.drives.delete(key);
}

/* ---------- Google ---------- */

const ALL_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file';
let tokenSeq = 0;

const personaOf = (auth) => {
  const key = String(auth?.credentials?.refresh_token || '').split(':')[1];
  if (!PERSONAS[key]) throw new Error('invalid_grant');
  return key;
};

class FakeOAuth2 {
  constructor(clientId, clientSecret, redirectUri) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.credentials = {};
  }

  generateAuthUrl({ state: oauthState, prompt }) {
    return `${state.googleBase}/auth?${new URLSearchParams({ state: oauthState, prompt, redirect_uri: this.redirectUri })}`;
  }

  async getToken(code) {
    const key = String(code).replace(/^persona:/, '');
    const p = PERSONAS[key];
    if (!p) throw new Error('invalid_grant: unknown code');
    return {
      tokens: {
        access_token: `at:${key}`,
        refresh_token: `rt:${key}:${++tokenSeq}`,
        id_token: `id:${key}`,
        scope: p.identityOnly ? 'openid https://www.googleapis.com/auth/userinfo.email' : ALL_SCOPES,
      },
    };
  }

  async verifyIdToken({ idToken, audience }) {
    const key = String(idToken).split(':')[1];
    const p = PERSONAS[key];
    if (!p || audience !== this.clientId) throw new Error('Wrong recipient, payload audience != requiredAudience');
    return { getPayload: () => ({ sub: p.sub, email: p.email, email_verified: true, name: p.name }) };
  }

  setCredentials(credentials) {
    this.credentials = credentials;
  }

  on() {
    return this;
  }

  async revokeToken(token) {
    state.revokedTokens.push(token);
  }
}

function gmailFor(auth) {
  const key = personaOf(auth);
  const check = () => {
    if (state.revokedPersonas.has(key)) throw new Error('invalid_grant');
  };
  const inbox = () => state.inboxes.get(key) || [];
  return {
    users: {
      messages: {
        list: async ({ q = '', maxResults = 100, pageToken }) => {
          check();
          const after = Number(/after:(\d+)/.exec(q)?.[1] || 0) * 1000;
          // Only the alert search is answered; statement and order searches find nothing.
          const hits = q.includes('from:hdfcbank.net')
            ? inbox().filter((m) => Number(m.internalDate) >= after).sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
            : [];
          const offset = Number(pageToken || 0);
          const page = hits.slice(offset, offset + maxResults);
          const next = offset + maxResults < hits.length ? String(offset + maxResults) : undefined;
          return { data: { ...(page.length && { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) }), ...(next && { nextPageToken: next }) } };
        },
        get: async ({ id }) => {
          check();
          const found = inbox().find((m) => m.id === id);
          if (!found) throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
          return { data: structuredClone(found) };
        },
        attachments: {
          get: async () => { throw new Error('The fake inbox has no attachments'); },
        },
      },
    },
  };
}

function driveFor(auth) {
  const key = personaOf(auth);
  if (!state.drives.has(key)) state.drives.set(key, new Map());
  const files = state.drives.get(key);
  return {
    files: {
      list: async () => ({ data: { files: [...files.keys()].map((id) => ({ id, name: 'expense-tracker-data.json' })) } }),
      create: async ({ media }) => {
        const id = `drive-${key}`;
        files.set(id, media.body);
        return { data: { id } };
      },
      get: async ({ fileId }) => {
        if (!files.has(fileId)) throw Object.assign(new Error('File not found'), { code: 404 });
        return { data: files.get(fileId) };
      },
      update: async ({ fileId, media }) => {
        let body = '';
        for await (const chunk of media.body) body += chunk;
        files.set(fileId, body);
        return { data: {} };
      },
      delete: async ({ fileId }) => {
        files.delete(fileId);
      },
    },
  };
}

export const fakeGoogle = {
  auth: { OAuth2: FakeOAuth2 },
  gmail: ({ auth }) => gmailFor(auth),
  drive: ({ auth }) => driveFor(auth),
};

/* ---------- Gmail over IMAP (MAIL_ACCESS=app-password) ---------- */

/** Each persona's Gmail app password: 16 letters, as Google makes them. */
export const appPasswordOf = (key) => `${key}${'qwertyuiopasdfgh'}`.replace(/[^a-z]/g, '').slice(0, 16);
// Personas whose app password has been removed in their Google account.
state.removedAppPasswords = new Set();
state.imapLogins = 0;

const hexId = (id) => Buffer.from(id).toString('hex');
const imapAuthError = () => Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Invalid credentials (Failure)' });

/**
 * The imapflow client, answering from the same fake inboxes as the Gmail API
 * fake. Ids go out as X-GM-MSGID numbers; searches honour the parts of Gmail's
 * X-GM-RAW syntax the alert search depends on.
 */
export class FakeImapFlow {
  constructor({ auth }) {
    this.user = String(auth.user).toLowerCase();
    this.pass = auth.pass;
    this.key = Object.keys(PERSONAS).find((k) => PERSONAS[k].email === this.user);
  }

  check() {
    if (!this.key || state.removedAppPasswords.has(this.key) || this.pass !== appPasswordOf(this.key)) throw imapAuthError();
  }

  async connect() {
    state.imapLogins++;
    this.check();
  }

  async logout() {}

  close() {}

  on() {
    return this;
  }

  async list() {
    return [{ path: 'INBOX' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }];
  }

  async mailboxOpen() {}

  inbox() {
    // A removed app password ends the session too, as Gmail does on its next command.
    this.check();
    return state.inboxes.get(this.key) || [];
  }

  async search(query) {
    const box = this.inbox();
    if (query.emailId) {
      const i = box.findIndex((m) => BigInt(`0x${hexId(m.id)}`).toString() === query.emailId);
      return i === -1 ? [] : [i + 1];
    }
    const q = String(query.gmraw || '');
    const after = Number(/after:(\d+)/.exec(q)?.[1] || 0) * 1000;
    if (!q.includes('from:hdfcbank.net')) return [];
    return box.map((m, i) => (Number(m.internalDate) >= after ? i + 1 : 0)).filter(Boolean);
  }

  message(uid) {
    const m = this.inbox()[Number(uid) - 1];
    if (!m) return null;
    const headers = m.payload.headers.map((h) => `${h.name}: ${h.value}`).join('\r\n');
    return {
      uid: Number(uid),
      emailId: BigInt(`0x${hexId(m.id)}`).toString(),
      internalDate: new Date(Number(m.internalDate)),
      headers: Buffer.from(`${headers}\r\n\r\n`),
      bodyStructure: { type: 'text/plain', parameters: { charset: 'utf-8' }, size: 100 },
      body: Buffer.from(m.payload.body.data, 'base64url'),
    };
  }

  async* fetch(range, query) {
    for (const uid of String(range).split(',')) {
      const m = this.message(uid);
      if (m) yield query.emailId ? { uid: m.uid, emailId: m.emailId } : m;
    }
  }

  async fetchOne(uid) {
    return this.message(uid);
  }

  async download(uid, part) {
    const m = this.message(uid);
    if (!m || part !== '1') return {};
    return { meta: { contentType: 'text/plain' }, content: Readable.from([m.body]) };
  }
}

export const ledgerOf = (key) => {
  const body = state.drives.get(key)?.get(`drive-${key}`);
  return body ? JSON.parse(body) : null;
};

/* ---------- Claude ---------- */

const CATEGORY = {
  swiggy: ['Food'], zepto: ['Groceries'], uber: ['Travel'], amazon: ['Shopping', 'Electronics'], apollo: ['Health'], netflix: ['Subscriptions'],
};

function spend(amount, raw, bank, card, paymentType) {
  const word = raw.trim().split(/\s+/)[0].toLowerCase();
  const [category = 'General', other = null] = CATEGORY[word] || [];
  return {
    isTransaction: true,
    amount: Number(String(amount).replace(/,/g, '')),
    currency: 'INR',
    merchant: word[0].toUpperCase() + word.slice(1),
    bank,
    cardLast4: card,
    paymentType,
    category,
    categorySure: !other,
    otherCategory: other,
    reasoning: `A ${paymentType.toLowerCase()} spend at ${raw}.`,
  };
}

/** Reads the alerts above the way a careful model would, deterministically. */
function readAlert(prompt) {
  const subject = /Subject: (.*)/.exec(prompt)?.[1] || '';
  const body = prompt.split('Body:\n')[1]?.split('\n\nRULES')[0] || '';
  const none = {
    isTransaction: false, amount: null, currency: null, merchant: null, bank: null, cardLast4: null,
    paymentType: null, category: null, categorySure: true, otherCategory: null, reasoning: 'Not a completed spend.',
  };
  if (/cashback|offer|otp|declined|refund/i.test(`${subject} ${body}`)) return none;
  let m = /Rs\.([\d,]+\.\d{2}) has been debited on your HDFC Bank Credit Card ending (\d{4}) towards (.+?) on \d/.exec(body);
  if (m) return spend(m[1], m[3], 'HDFC', m[2], 'Credit Card');
  m = /INR ([\d,]+\.\d{2}) spent using ICICI Bank Card XX(\d{4}) on [\w-]+ on (.+?)\. Avl/.exec(body);
  if (m) return spend(m[1], m[3], 'ICICI', m[2], 'Credit Card');
  return none;
}

/** Stands in for both model SDKs: the app calls them identically. */
export class FakeClaude {
  constructor() {
    this.messages = {
      create: async ({ tools, messages }) => {
        state.model.calls += 1;
        if (state.model.down) throw Object.assign(new Error('The security token included in the request is invalid.'), { status: 401 });
        const tool = tools[0].name;
        let input;
        if (tool === 'record_transaction') input = readAlert(messages[0].content);
        else if (tool === 'record_order') input = { isOrder: false, summary: null, items: [] };
        else throw new Error(`The fake model has no answer for ${tool}`);
        return { content: [{ type: 'tool_use', id: `toolu_${state.model.calls}`, name: tool, input }], stop_reason: 'tool_use' };
      },
    };
  }
}

/* ---------- Razorpay ---------- */

const rz = state.razorpay;
for (const [id, period, amount] of [['plan_e2e_monthly', 'monthly', 9900], ['plan_e2e_yearly', 'yearly', 99900]]) {
  rz.plans.set(id, {
    id, entity: 'plan', interval: 1, period,
    item: { id: `item_${period}`, active: true, name: `Expenses ${period}`, amount, unit_amount: amount, currency: 'INR' },
    notes: {}, created_at: unix(Date.now()),
  });
}

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const rzError = (description) => ({ error: { code: 'BAD_REQUEST_ERROR', description } });

export const razorpay = {
  /** The customer's autopay is authorised; the first charge is still to come. */
  authenticate(id) {
    const sub = rz.subs.get(id);
    Object.assign(sub, { status: 'authenticated', auth_attempts: 1 });
    return sub;
  },
  /** Razorpay charges one cycle. */
  charge(id, { from = Date.now(), days = null } = {}) {
    const sub = rz.subs.get(id);
    const yearly = sub.plan_id.includes('yearly');
    const length = days ?? (yearly ? 365 : 30);
    Object.assign(sub, {
      status: 'active', current_start: unix(from), current_end: unix(from + length * DAY),
      paid_count: sub.paid_count + 1, remaining_count: sub.total_count - sub.paid_count - 1, charge_at: unix(from + length * DAY),
    });
    return sub;
  },
  halt(id) {
    const sub = rz.subs.get(id);
    Object.assign(sub, { status: 'halted' });
    return sub;
  },
  last: (path) => [...rz.calls].reverse().find((c) => c.path === path),
  get: (id) => rz.subs.get(id),
};

async function razorpayApi(url, opts) {
  const expected = `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  if (opts.headers?.Authorization !== expected) return reply(401, rzError('Authentication failed'));

  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  rz.calls.push({ method, path: url.pathname, body });
  let m;

  if (method === 'GET' && (m = url.pathname.match(/^\/v1\/plans\/([^/]+)$/))) {
    return rz.plans.has(m[1]) ? reply(200, rz.plans.get(m[1])) : reply(400, rzError('The id provided does not exist'));
  }

  if (method === 'POST' && url.pathname === '/v1/subscriptions') {
    if (!rz.plans.has(body.plan_id)) return reply(400, rzError('The id provided does not exist'));
    if (!(body.total_count > 0)) return reply(400, rzError('The total count field is required.'));
    if (body.start_at && body.start_at * 1000 < Date.now()) return reply(400, rzError('start_at cannot be lesser than the current time'));
    const id = `sub_e2e${String(++rz.seq).padStart(7, '0')}`;
    const sub = {
      id, entity: 'subscription', plan_id: body.plan_id, customer_id: null, status: 'created',
      current_start: null, current_end: null, ended_at: null, quantity: 1, notes: body.notes || {},
      charge_at: body.start_at || null, start_at: body.start_at || null, end_at: null, auth_attempts: 0,
      total_count: body.total_count, paid_count: 0, customer_notify: body.customer_notify, created_at: unix(Date.now()),
      expire_by: null, short_url: `https://rzp.io/i/${id}`, has_scheduled_changes: false, offer_id: null, remaining_count: body.total_count,
    };
    rz.subs.set(id, sub);
    return reply(200, sub);
  }

  if (method === 'GET' && (m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
    const sub = rz.subs.get(m[1]);
    if (!sub) return reply(400, rzError('The id provided does not exist'));
    // The browser walkthrough has no real Checkout, so paying is simulated here.
    if (rz.autoChargeOnFetch && sub.status === 'created') {
      if (sub.start_at && sub.start_at * 1000 > Date.now()) razorpay.authenticate(sub.id);
      else razorpay.charge(sub.id);
    }
    return reply(200, sub);
  }

  if (method === 'POST' && (m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/))) {
    const sub = rz.subs.get(m[1]);
    if (!sub) return reply(400, rzError('The id provided does not exist'));
    if (['cancelled', 'completed', 'expired'].includes(sub.status)) return reply(400, rzError(`Subscription is not cancellable in ${sub.status} status.`));
    Object.assign(sub, { status: 'cancelled', ended_at: unix(Date.now()) });
    return reply(200, sub);
  }

  return reply(404, rzError('The requested URL was not found on the server.'));
}

/** The network, as far as the app is concerned. Anything unexpected fails loudly. */
export function installFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.razorpay.com') return razorpayApi(url, opts);
    if (url.hostname === 'api.frankfurter.app') return reply(200, { rates: { INR: 83.5 } });
    // The free key check the first-run screen makes: keys containing "good" work.
    if (url.hostname === 'api.anthropic.com' && url.pathname === '/v1/models') {
      const key = new Headers(opts.headers).get('x-api-key') || '';
      return key.includes('good') ? reply(200, { data: [] }) : reply(401, { error: { type: 'authentication_error' } });
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, opts);
    throw new Error(`e2e: blocked a network call to ${url.hostname}`);
  };
}

/** A webhook as Razorpay would send it. */
export function webhookEvent(name, sub, { payment = false } = {}) {
  const amount = rz.plans.get(sub.plan_id)?.item.amount;
  return {
    entity: 'event',
    account_id: 'acc_e2e',
    event: name,
    contains: payment ? ['subscription', 'payment'] : ['subscription'],
    payload: {
      subscription: { entity: structuredClone(sub) },
      ...(payment && { payment: { entity: { id: `pay_${crypto.randomBytes(7).toString('hex')}`, entity: 'payment', amount, currency: 'INR', status: 'captured', method: 'upi' } } }),
    },
    created_at: unix(Date.now()),
  };
}

export async function deliverWebhook(base, event, { id = `evt_${crypto.randomBytes(8).toString('hex')}`, secret = process.env.RAZORPAY_WEBHOOK_SECRET } = {}) {
  const body = JSON.stringify(event);
  const res = await fetch(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmacHex(secret, body), 'x-razorpay-event-id': id },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null), id };
}

/** What Razorpay Checkout hands the browser after the customer authorises. */
export function checkoutResponse(subscriptionId, secret = process.env.RAZORPAY_KEY_SECRET) {
  const paymentId = `pay_${crypto.randomBytes(7).toString('hex')}`;
  return {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: hmacHex(secret, `${paymentId}|${subscriptionId}`),
  };
}

export const time = { MIN, HOUR, DAY, unix };
