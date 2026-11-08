import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.SESSION_SECRET ||= 'x'.repeat(32);
const imap = await import('../server/gmail/imap.js');
const { runAsUser } = await import('../server/context.js');
const gmail = await import('../server/gmail/client.js');

// What Gmail's IMAP server reports for a typical bank statement email: an
// HTML-and-text body, plus a PDF.
const STATEMENT = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', parameters: { charset: 'utf-8' }, size: 40 },
        { part: '1.2', type: 'text/html', parameters: { charset: 'utf-8' }, size: 90 },
      ],
    },
    { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'Statement_Sep.pdf' }, size: 51234 },
  ],
};

const parts = {
  '1.1': 'Your statement for September is attached.',
  '1.2': '<p>Your statement for <b>September</b> is attached.</p>',
  2: '%PDF-1.7 fake',
};

test('a multipart email becomes the Gmail API payload: text inline, the PDF left for later', async () => {
  const fetched = [];
  const payload = await imap.toPayload(STATEMENT, async (p) => { fetched.push(p); return Buffer.from(parts[p]); }, { root: true });
  const message = { payload: { ...payload, headers: [] } };

  assert.deepEqual(fetched, ['1.1', '1.2'], 'the PDF is not downloaded just to list it');
  assert.equal(gmail.extractBody(message), parts['1.1'], 'text/plain is preferred, as with the API');
  assert.deepEqual(gmail.listAttachments(message), [
    { filename: 'Statement_Sep.pdf', mimeType: 'application/pdf', attachmentId: '2', size: 51234 },
  ]);
});

test('an HTML-only alert is read as stripped HTML, exactly as from the API', async () => {
  const html = '<div>Rs.1,299.00 has been debited<br>towards SWIGGY</div>';
  const payload = await imap.toPayload({ type: 'text/html', parameters: { charset: 'utf-8' }, size: 60 }, async (p) => {
    assert.equal(p, '1', 'a single-part message has its body at part 1');
    return Buffer.from(html);
  }, { root: true });
  const viaImap = gmail.extractBody({ payload: { ...payload, headers: [] } });
  const viaApi = gmail.extractBody({ payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } } });
  assert.equal(viaImap, viaApi);
  assert.equal(viaImap, 'Rs.1,299.00 has been debited\ntowards SWIGGY');
});

test('headers are unfolded and decoded, so sender, subject and DKIM checks read them as the API gives them', () => {
  const raw = Buffer.from([
    'Authentication-Results: mx.google.com;',
    '       dkim=pass header.i=@hdfcbank.net header.s=s2048;',
    '       spf=pass',
    'From: "HDFC Bank InstaAlerts" <alerts@hdfcbank.net>',
    'Subject: =?UTF-8?B?4oK5IEFsZXJ0IDogVXBkYXRl?=',
    '',
    '',
  ].join('\r\n'));
  const headers = imap.parseHeaders(raw);
  const message = { internalDate: '1790000000000', payload: { headers } };

  assert.equal(gmail.extractSender(message), 'alerts@hdfcbank.net');
  assert.equal(gmail.extractSubject(message), '₹ Alert : Update');
  assert.equal(gmail.isAuthenticSender(message, 'alerts@hdfcbank.net'), true);
});

test('X-GM-MSGID and the Gmail API id are the same number, so recorded ids carry over', () => {
  // Gmail documents the API id as the hex form of IMAP's decimal X-GM-MSGID.
  assert.equal(imap.toApiId('1278411755190542481'), '11bdd4b7d0d0e091');
  assert.equal(imap.toApiId(BigInt('0x19a2f3c4d5e6f708').toString()), '19a2f3c4d5e6f708');
});

function fakeClient({ refuse = false, messages = {} } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push('connect');
      if (refuse) throw Object.assign(new Error('Command failed'), { authenticationFailed: true });
    },
    async logout() { calls.push('logout'); },
    close() {},
    on() {},
    async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/Todos', specialUse: '\\All' }]; },
    async mailboxOpen(path) { calls.push(`open ${path}`); },
    async search(q) {
      calls.push(q);
      if (q.gmraw) return Object.keys(messages).map(Number);
      return Object.entries(messages).filter(([, m]) => m.emailId === q.emailId).map(([uid]) => Number(uid));
    },
    async* fetch(range) {
      for (const uid of range.split(',')) yield { uid: Number(uid), emailId: messages[uid].emailId };
    },
    async fetchOne(uid) {
      const m = messages[uid];
      return { uid: Number(uid), emailId: m.emailId, internalDate: new Date(m.at), headers: Buffer.from(`From: ${m.from}\r\n\r\n`), bodyStructure: { type: 'text/plain', size: 10 } };
    },
    async download(uid, part) {
      assert.equal(part, '1');
      return { content: Readable.from([Buffer.from(messages[uid].body)]) };
    },
  };
}

test('searches run Gmail\'s own query on "All Mail" whatever its name, newest first, in API ids', async () => {
  const client = fakeClient({
    messages: {
      7: { emailId: '1278411755190542481', at: 1790000000000, from: 'alerts@hdfcbank.net', body: 'Rs.10 spent' },
      9: { emailId: '1278411755190542482', at: 1790000100000, from: 'alerts@hdfcbank.net', body: 'Rs.20 spent' },
    },
  });
  imap.__setImapForTests(() => client);
  const user = { id: 'u1', email: 'asha@gmail.com' };
  imap.prepare(user, 'abcdabcdabcdabcd');

  await runAsUser(user, async () => {
    const ids = await imap.searchIds('from:hdfcbank.net after:1', { limit: 25 });
    assert.deepEqual(ids, ['11bdd4b7d0d0e092', '11bdd4b7d0d0e091']);
    const message = await imap.getMessage(ids[1]);
    assert.equal(message.id, '11bdd4b7d0d0e091');
    assert.equal(message.internalDate, '1790000000000');
    assert.equal(gmail.extractBody(message), 'Rs.10 spent');
  });
  assert.ok(client.calls.includes('open [Gmail]/Todos'), 'found by its special-use flag, not its English name');
  assert.ok(client.calls.some((c) => c.gmraw === 'from:hdfcbank.net after:1'), 'the API query is passed through unchanged');
  assert.equal(client.calls.filter((c) => c === 'connect').length, 1, 'one connection serves the whole poll');
  imap.forget('u1');
});

test('a refused app password surfaces as "sign in again", not as a passing failure', async () => {
  imap.__setImapForTests(() => fakeClient({ refuse: true }));
  const user = { id: 'u2', email: 'asha@gmail.com' };
  imap.prepare(user, 'abcdabcdabcdabcd');
  await assert.rejects(runAsUser(user, () => imap.searchIds('x')), new RegExp(imap.APP_PASSWORD_REJECTED));
  assert.deepEqual(await imap.verifyAppPassword('asha@gmail.com', 'nope'), { ok: false, reason: 'auth', message: 'Command failed' });
  imap.forget('u2');
});
