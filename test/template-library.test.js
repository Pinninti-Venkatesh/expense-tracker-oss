import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.TEMPLATE_LIBRARY_MIN_ACCOUNTS = '3';

const { induceTemplate } = await import('../server/templates/alerts.js');
const {
  sharableForm, formKey, contributorId, contribute, dispute, findShared, personalWords, __resetLibraryCacheForTests,
} = await import('../server/templates/library.js');
const { memoryBackend, __setLibraryBackendForTests } = await import('../server/templates/libraryStore.js');
const {
  adoptShared, findTemplateRead, learnFromModel, SHARED_TRIAL_AGREEMENTS,
} = await import('../server/templates/alertLearning.js');

const SENDER = 'alerts@hdfcbank.net';

const alert = (amount, merchant, name, { card = '4417', day = '12', ref = '123456' } = {}) =>
  `Alert : Update on your HDFC Bank Credit Card\nDear ${name},\nRs.${amount} has been debited on your HDFC Bank Credit Card ending ${card} towards ${merchant} on ${day} Sep, 2026 at 20:14:05.\nAuthorization code:- ${ref}\nIf you have not done this transaction, please call 18002586161.\nWarm Regards, HDFC Bank`;

const example = (amount, raw, clean, name, opts = {}) => ({
  text: alert(amount, raw, name, opts),
  amount: Number(amount.replace(/,/g, '')),
  merchant: clean,
  category: 'Food',
  cardLast4: opts.card || '4417',
  bank: 'HDFC',
  paymentType: 'Credit Card',
  currency: 'INR',
});

/** A template one person's account learned from their own two alerts and proved. */
function liveTemplateFor(name, card = '4417') {
  const { template } = induceTemplate(
    example('642.00', 'SWIGGY BANGALORE IN', 'Swiggy', name, { card }),
    example('1,299.00', 'ZEPTO MARKETPLACE PVT', 'Zepto', name, { card, day: '13', ref: '654321' }),
  );
  return { ...template, id: 'tpl_x', state: 'live', agree: 5 };
}

const people = {
  asha: { id: 'acc_asha', name: 'Asha Rao', email: 'asha.rao@gmail.com' },
  vikram: { id: 'acc_vikram', name: 'Vikram Mehta', email: 'vmehta@outlook.com' },
  meera: { id: 'acc_meera', name: 'Meera Iyer', email: 'meera.iyer@gmail.com' },
  dev: { id: 'acc_dev', name: 'Dev Shah', email: 'devshah@gmail.com' },
  nisha: { id: 'acc_nisha', name: 'Nisha Pillai', email: 'nisha.p@gmail.com' },
};

let backend;
beforeEach(() => {
  backend = memoryBackend();
  __setLibraryBackendForTests(backend);
  __resetLibraryCacheForTests();
});

test("a person's own name and email words are scrubbed; amounts, merchants and cards never appear", () => {
  const form = sharableForm(liveTemplateFor('Asha Rao'), SENDER, people.asha);
  assert.ok(form);
  const text = JSON.stringify(form).toLowerCase();
  for (const secret of ['asha', 'rao', 'swiggy', 'zepto', '642', '1,299', '4417', '123456']) {
    assert.equal(text.includes(secret), false, `form leaks "${secret}"`);
  }
  assert.deepEqual([...personalWords(people.asha)].sort(), ['asha', 'rao']);
});

test('two people with different names and cards produce the same shareable form', () => {
  const a = sharableForm(liveTemplateFor('Asha Rao', '4417'), SENDER, people.asha);
  const b = sharableForm(liveTemplateFor('Vikram Mehta', '8812'), SENDER, people.vikram);
  assert.equal(formKey(a), formKey(b));
});

test('without scrubbing, a name makes the form unique to that person, so it could never reach the threshold', () => {
  const a = sharableForm(liveTemplateFor('Asha Rao'), SENDER, {});
  const b = sharableForm(liveTemplateFor('Vikram Mehta'), SENDER, {});
  assert.notEqual(formKey(a), formKey(b));
});

test('only proven, self-learned formats from a known bank, with no fixed card, can be shared', () => {
  const live = liveTemplateFor('Asha Rao');
  assert.equal(sharableForm({ ...live, state: 'trial' }, SENDER, people.asha), null);
  assert.equal(sharableForm({ ...live, state: 'retired' }, SENDER, people.asha), null);
  assert.equal(sharableForm({ ...live, origin: 'shared' }, SENDER, people.asha), null);
  assert.equal(sharableForm({ ...live, constants: { ...live.constants, cardLast4: '4417' } }, SENDER, people.asha), null);
  assert.equal(sharableForm(live, 'offers@some-shop.com', people.asha), null);
});

test('a personal word between two fields makes the form unshareable rather than unreadable', () => {
  const live = liveTemplateFor('Asha Rao');
  // The word between the card and the merchant is "towards". Call someone that.
  assert.equal(sharableForm(live, SENDER, { name: 'Towards' }), null);
});

test('the library keeps nothing readable until enough different accounts offer the same form', async () => {
  const r1 = await contribute(people.asha.id, SENDER, liveTemplateFor('Asha Rao'), people.asha);
  assert.equal(r1.outcome, 'pending');

  // The same account offering twice doesn't count twice.
  assert.equal((await contribute(people.asha.id, SENDER, liveTemplateFor('Asha Rao'), people.asha)).outcome, 'already');

  assert.equal((await contribute(people.vikram.id, SENDER, liveTemplateFor('Vikram Mehta', '8812'), people.vikram)).outcome, 'pending');

  const pending = backend.records.get(r1.key);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.form, undefined);
  const stored = JSON.stringify(pending);
  for (const leak of ['hdfc', 'debited', people.asha.id, people.vikram.id]) {
    assert.equal(stored.toLowerCase().includes(leak.toLowerCase()), false, `pending record holds "${leak}"`);
  }
  assert.equal(pending.contributors.includes(contributorId(people.asha.id)), true);
  assert.equal(await findShared(SENDER, alert('2,499.00', 'AMAZON PAY INDIA', 'Dev Shah')), null);

  const r3 = await contribute(people.meera.id, SENDER, liveTemplateFor('Meera Iyer', '1034'), people.meera);
  assert.equal(r3.outcome, 'published');
  assert.equal(backend.records.get(r1.key).status, 'published');
});

test('a published format reads a fourth person\'s alert, and only for that sender', async () => {
  for (const p of [people.asha, people.vikram, people.meera]) {
    await contribute(p.id, SENDER, liveTemplateFor(p.name), p);
  }
  const text = alert('2,499.00', 'AMAZON PAY INDIA', 'Dev Shah', { card: '7730' });
  const found = await findShared(SENDER, text);
  assert.ok(found);
  assert.equal(await findShared('alerts@icicibank.com', text), null);
  assert.equal(await findShared(SENDER, text, { exclude: [found.key] }), null);
});

test('an adopted format starts on a short trial, earns its place, and a retirement is remembered and disputed', async () => {
  for (const p of [people.asha, people.vikram, people.meera]) {
    await contribute(p.id, SENDER, liveTemplateFor(p.name), p);
  }
  const text = (amount, raw) => alert(amount, raw, 'Dev Shah', { card: '7730' });
  const shared = await findShared(SENDER, text('2,499.00', 'AMAZON PAY INDIA'));

  const db = {};
  const adopted = adoptShared(db, SENDER, shared);
  assert.equal(adopted.state, 'trial');
  assert.equal(adopted.trialAgreements, SHARED_TRIAL_AGREEMENTS);
  assert.equal(adopted.origin, 'shared');
  assert.equal(adoptShared(db, SENDER, shared), null, 'never adopted twice');

  const answer = (amount, clean) => ({ amount: Number(amount.replace(/,/g, '')), merchant: clean, category: 'Shopping', cardLast4: '7730', bank: 'HDFC', paymentType: 'Credit Card', currency: 'INR' });
  for (let i = 1; i <= SHARED_TRIAL_AGREEMENTS; i++) {
    const t = text('2,499.00', 'AMAZON PAY INDIA');
    const hit = findTemplateRead(db, SENDER, t);
    const outcome = learnFromModel(db, { sender: SENDER, text: t, extracted: answer('2,499.00', 'Amazon'), hit });
    assert.equal(outcome, i === SHARED_TRIAL_AGREEMENTS ? 'promoted' : 'agreed');
  }

  // This account's model disagrees once: retired here, remembered, and never adopted again.
  const t = text('310.00', 'UBER INDIA');
  const hit = findTemplateRead(db, SENDER, t);
  assert.equal(learnFromModel(db, { sender: SENDER, text: t, extracted: answer('3,100.00', 'Uber'), hit }), 'retired');
  assert.deepEqual(db.retiredSharedKeys, [shared.key]);
  db.alertTemplates[SENDER] = [];
  assert.equal(adoptShared(db, SENDER, shared), null);

  // Disputes from two different accounts withdraw it for everyone.
  assert.equal((await dispute(people.dev.id, shared.key)).outcome, 'disputed');
  assert.equal((await dispute(people.dev.id, shared.key)).outcome, 'already');
  assert.equal((await dispute(people.nisha.id, shared.key)).outcome, 'withdrawn');
  assert.equal(await findShared(SENDER, text('2,499.00', 'AMAZON PAY INDIA')), null);
  assert.equal(backend.records.get(shared.key).form, null);

  // A withdrawn format can't come back by being offered again.
  assert.equal((await contribute('acc_new', SENDER, liveTemplateFor('Ravi Kumar'), { name: 'Ravi Kumar' })).outcome, 'withdrawn');
});

test('contributor ids are keyed hashes, different per account and not the account id', () => {
  const a = contributorId('acc_asha');
  assert.notEqual(a, contributorId('acc_vikram'));
  assert.equal(a, contributorId('acc_asha'));
  assert.match(a, /^[0-9a-f]{64}$/);
});
