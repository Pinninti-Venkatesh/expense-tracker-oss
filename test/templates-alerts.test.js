import { test } from 'node:test';
import assert from 'node:assert/strict';
import { induceTemplate, matchTemplate } from '../server/templates/alerts.js';
import {
  findTemplateRead, aliasFor, canSkipModel, extractionFromTemplate, learnFromModel, noteTemplateUse,
  TRIAL_AGREEMENTS, SPOT_CHECK_EVERY,
} from '../server/templates/alertLearning.js';
import { isAuthenticSender } from '../server/gmail/authResults.js';

const SENDER = 'alerts@hdfcbank.net';

const alert = (amount, merchant, { card = '4417', day = '12', month = 'Sep', time = '20:14:05', ref = '123456' } = {}) =>
  `Alert : Update on your HDFC Bank Credit Card\nDear Customer,\nRs.${amount} has been debited on your HDFC Bank Credit Card ending ${card} towards ${merchant} on ${day} ${month}, 2026 at ${time}.\nAuthorization code:- ${ref}\nIf you have not done this transaction, please call 18002586161.\nWarm Regards, HDFC Bank`;

const example = (amount, raw, clean, opts = {}) => ({
  text: alert(amount, raw, opts),
  amount: Number(amount.replace(/,/g, '')),
  merchant: clean,
  category: 'Food',
  cardLast4: opts.card || '4417',
  bank: 'HDFC',
  paymentType: 'Credit Card',
  currency: 'INR',
});

test('two alerts in one layout become a template that reads the next one', () => {
  const learned = induceTemplate(
    example('642.00', 'SWIGGY BANGALORE IN', 'Swiggy'),
    example('1,299.00', 'ZEPTO MARKETPLACE PVT', 'Zepto', { day: '13', time: '09:02:11', ref: '654321' }),
  );
  assert.ok(learned);
  assert.deepEqual(learned.raw, { a: 'SWIGGY BANGALORE IN', b: 'ZEPTO MARKETPLACE PVT' });

  // A different month, time, reference and merchant: all data, none of it fixed wording.
  const read = matchTemplate(learned.template, alert('2,499.00', 'AMAZON PAY INDIA', { day: '3', month: 'Oct', time: '11:45:00', ref: '998877' }));
  assert.deepEqual(read, { amount: 2499, merchantRaw: 'AMAZON PAY INDIA', last4: '4417' });
});

test('a template does not read an email in another layout', () => {
  const { template } = induceTemplate(example('642.00', 'SWIGGY BANGALORE IN', 'Swiggy'), example('1,299.00', 'ZEPTO MARKETPLACE PVT', 'Zepto'));
  const credit = 'Alert : Update on your HDFC Bank account\nDear Customer,\nRs.5,000.00 has been credited to your account ending 2210 by NEFT from ACME PAYROLL.';
  assert.equal(matchTemplate(template, credit), null);
});

test('two alerts for the same merchant teach nothing', () => {
  assert.equal(induceTemplate(example('642.00', 'SWIGGY BANGALORE IN', 'Swiggy'), example('310.00', 'SWIGGY BANGALORE IN', 'Swiggy')), null);
});

test('a template earns its place, then reads alone, then is lost on one disagreement', () => {
  const db = {};
  const first = example('642.00', 'SWIGGY BANGALORE IN', 'Swiggy');
  const second = example('1,299.00', 'ZEPTO MARKETPLACE PVT', 'Zepto');
  assert.equal(learnFromModel(db, { sender: SENDER, text: first.text, extracted: first, hit: null }), 'example');
  assert.equal(learnFromModel(db, { sender: SENDER, text: second.text, extracted: second, hit: null }), 'learned');
  assert.equal(db.alertTemplates[SENDER][0].state, 'trial');
  assert.deepEqual(db.alertExamples[SENDER], []); // raw examples are dropped once used
  assert.equal(aliasFor(db, 'SWIGGY BANGALORE IN').merchant, 'Swiggy');

  const text = alert('2,499.00', 'AMAZON PAY INDIA');
  const answer = { ...example('2,499.00', 'AMAZON PAY INDIA', 'Amazon'), category: 'Shopping' };
  for (let i = 1; i <= TRIAL_AGREEMENTS; i++) {
    const hit = findTemplateRead(db, SENDER, text);
    assert.equal(canSkipModel(hit, aliasFor(db, hit.fields.merchantRaw)), false, 'still on trial');
    const outcome = learnFromModel(db, { sender: SENDER, text, extracted: answer, hit });
    assert.equal(outcome, i === TRIAL_AGREEMENTS ? 'promoted' : 'agreed');
  }

  const hit = findTemplateRead(db, SENDER, text);
  const alias = aliasFor(db, hit.fields.merchantRaw);
  assert.equal(canSkipModel(hit, alias), true);
  assert.deepEqual(
    { ...extractionFromTemplate(hit, alias), reasoning: undefined },
    { amount: 2499, currency: 'INR', merchant: 'Amazon', bank: 'HDFC', cardLast4: '4417', paymentType: 'Credit Card', category: 'Shopping', categorySource: 'template', reasoning: undefined },
  );

  // A merchant the template has never seen still goes to the model.
  const unknown = findTemplateRead(db, SENDER, alert('99.00', 'BLUE TOKAI COFFEE'));
  assert.equal(canSkipModel(unknown, aliasFor(db, unknown.fields.merchantRaw)), false);

  const wrong = { ...answer, amount: 2400 };
  assert.equal(learnFromModel(db, { sender: SENDER, text, extracted: wrong, hit }), 'retired');
  assert.equal(findTemplateRead(db, SENDER, text), null);
});

test('a live template is still checked by the model now and then', () => {
  const hit = { state: 'live', uses: SPOT_CHECK_EVERY - 1 };
  assert.equal(canSkipModel(hit, { merchant: 'Swiggy' }), false);
  assert.equal(canSkipModel({ ...hit, uses: 3 }, { merchant: 'Swiggy' }), true);

  const db = { alertTemplates: { [SENDER]: [{ id: 't1', uses: 3 }] } };
  noteTemplateUse(db, SENDER, 't1');
  assert.equal(db.alertTemplates[SENDER][0].uses, 4);
});

test('only Gmail-verified senders count as authentic', () => {
  const msg = (...values) => ({ payload: { headers: values.map((value) => ({ name: 'Authentication-Results', value })) } });
  assert.equal(isAuthenticSender(msg('mx.google.com; dkim=pass header.i=@hdfcbank.net header.s=sel; spf=pass'), SENDER), true);
  assert.equal(isAuthenticSender(msg('mx.google.com; dkim=pass header.i=@evil.example header.s=sel'), SENDER), false);
  assert.equal(isAuthenticSender(msg('mx.google.com; dkim=fail header.i=@hdfcbank.net'), SENDER), false);
  // A forged header below Gmail's own is never read.
  assert.equal(isAuthenticSender(msg('mx.google.com; dkim=none', 'mx.google.com; dkim=pass header.i=@hdfcbank.net'), SENDER), false);
  assert.equal(isAuthenticSender(msg('attacker.example; dkim=pass header.i=@hdfcbank.net'), SENDER), false);
});
